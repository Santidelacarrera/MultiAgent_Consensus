import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CLEAN_PR, FAKE_AWS_KEY, makePr } from '../../agents/__tests__/fixtures';
import { AppModule } from '../src/app.module';
import { MemoryBus } from '../src/bus/memory_bus';
import { MemoryStore } from '../src/store/memory_store';

async function boot(overrides = {}): Promise<{ app: INestApplication; store: MemoryStore }> {
  const store = new MemoryStore();
  const mod = await Test.createTestingModule({
    imports: [AppModule.register({ busBackend: 'memory', agentTimeoutMs: 2000, busSecret: 'api-test-secret', ...overrides }, { bus: new MemoryBus(), store })],
  }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.useBodyParser('json', { limit: '12mb' });
  await app.init();
  return { app, store };
}

const body = (pr: ReturnType<typeof makePr>) => ({ pr: { provider: 'github', repo: pr.repo, number: pr.number, title: pr.title, headSha: pr.headSha, diff: pr.diff, author: 'dev' } });

describe('API HTTP del orquestador', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('GET /health', async () => {
    ({ app } = await boot());
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok', service: 'multiagent-consensus-orchestrator' });
  });

  it('POST /v1/debates → 202, y GET con waitMs devuelve la decisión y la minuta', async () => {
    ({ app } = await boot());
    const http = request(app.getHttpServer());
    const created = await http.post('/v1/debates').send(body(CLEAN_PR())).expect(202);
    expect(created.body.status).toBe('running');
    const done = await http.get(`/v1/debates/${created.body.id}?waitMs=5000`).expect(200);
    expect(done.body).toMatchObject({ status: 'approved', decision: 'APPROVED', verdict: 'APPROVED', rounds: 1 });
    expect(done.body.summary.finalVotes).toEqual({ red_team: 'approve', architect: 'approve', business_ops: 'approve' });
    const md = await http.get(`/v1/debates/${created.body.id}/minutes`).expect(200);
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.text).toContain('Minuta ejecutiva');
    const events = await http.get(`/v1/debates/${created.body.id}/events`).expect(200);
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['debate.started', 'debate.concluded']));
    const metrics = await http.get(`/v1/debates/${created.body.id}/metrics`).expect(200);
    expect(metrics.body).toEqual([expect.objectContaining({ round: 1, convergence: 1, outcome: 'APPROVED' })]);
    const full = await http.get(`/v1/debates/${created.body.id}?full=true`).expect(200);
    expect(full.body.result.rounds).toHaveLength(1);
  });

  it('es idempotente por (PR, commit) y permite forzar un nuevo debate', async () => {
    ({ app } = await boot());
    const http = request(app.getHttpServer());
    const pr = CLEAN_PR();
    const a = await http.post('/v1/debates').send(body(pr)).expect(202);
    await http.get(`/v1/debates/${a.body.id}?waitMs=5000`).expect(200);
    const b = await http.post('/v1/debates').send(body(pr)).expect(202);
    expect(b.body.id).toBe(a.body.id);
    const c = await http.post('/v1/debates').send({ ...body(pr), force: true }).expect(202);
    expect(c.body.id).not.toBe(a.body.id);
    await http.get(`/v1/debates/${c.body.id}?waitMs=5000`).expect(200);
    const hist = await http.get('/v1/debates').query({ prId: 'github:acme/shop#42' }).expect(200);
    expect(hist.body).toHaveLength(2);
  });

  it('valida la entrada (400) y devuelve 404 para debates inexistentes', async () => {
    ({ app } = await boot());
    const http = request(app.getHttpServer());
    await http.post('/v1/debates').send({ pr: { provider: 'svn' } }).expect(400);
    await http.post('/v1/debates').send({}).expect(400);
    await http.get('/v1/debates/nope').expect(404);
    await http.get('/v1/debates').expect(400);
  });

  it('exige API key cuando está configurada', async () => {
    ({ app } = await boot({ apiKey: 'k3y' }));
    const http = request(app.getHttpServer());
    await http.post('/v1/debates').send(body(CLEAN_PR())).expect(401);
    await http.post('/v1/debates').set('x-api-key', 'bad').send(body(CLEAN_PR())).expect(401);
    await http.post('/v1/debates').set('x-api-key', 'k3y').send(body(CLEAN_PR())).expect(202);
    await http.get('/health').expect(200); // health siempre abierto
  });

  it('escalado: un humano resuelve y la minuta refleja la decisión', async () => {
    ({ app } = await boot());
    const http = request(app.getHttpServer());
    const pr = makePr([{ path: 'src/db.ts', added: ['const q = `SELECT * FROM users WHERE id = ${req.params.id}`;'] }, { path: 'src/db.test.ts', added: ['t'] }]);
    const c = await http.post('/v1/debates').send(body(pr)).expect(202);
    const d = await http.get(`/v1/debates/${c.body.id}?waitMs=5000`).expect(200);
    expect(d.body).toMatchObject({ status: 'escalated', decision: 'ESCALATED', verdict: 'PENDING_HUMAN', rounds: 3 });

    await http.post(`/v1/debates/${c.body.id}/resolution`).send({ reviewer: 'alice' }).expect(400);
    const r = await http.post(`/v1/debates/${c.body.id}/resolution`).send({ reviewer: 'alice', decision: 'reject', rationale: 'Inyección SQL real' }).expect(201);
    expect(r.body).toMatchObject({ status: 'resolved_rejected', verdict: 'REJECTED' });
    const md = await http.get(`/v1/debates/${c.body.id}/minutes`).expect(200);
    expect(md.text).toMatch(/alice.*RECHAZAR/s);
    // no se puede resolver dos veces
    await http.post(`/v1/debates/${c.body.id}/resolution`).send({ reviewer: 'bob', decision: 'approve', rationale: 'x' }).expect(409);
  });

  it('rechaza resolver un debate que no está escalado', async () => {
    ({ app } = await boot());
    const http = request(app.getHttpServer());
    const c = await http.post('/v1/debates').send(body(CLEAN_PR())).expect(202);
    await http.get(`/v1/debates/${c.body.id}?waitMs=5000`).expect(200);
    await http.post(`/v1/debates/${c.body.id}/resolution`).send({ reviewer: 'a', decision: 'approve', rationale: 'x' }).expect(409);
  });

  it('PR con secreto → REJECTED con veto', async () => {
    ({ app } = await boot());
    const http = request(app.getHttpServer());
    const pr = makePr([{ path: 'src/cfg.ts', added: [`export const KEY = "${FAKE_AWS_KEY}";`] }, { path: 'src/cfg.test.ts', added: ['t'] }]);
    const c = await http.post('/v1/debates').send(body(pr)).expect(202);
    const d = await http.get(`/v1/debates/${c.body.id}?waitMs=5000`).expect(200);
    expect(d.body).toMatchObject({ status: 'rejected', verdict: 'REJECTED' });
    expect(d.body.summary.hardBlockers.length).toBe(1);
  });

  it('marca como error los debates huérfanos al arrancar', async () => {
    const store = new MemoryStore();
    await store.saveDebate({
      id: 'orphan', prId: 'github:a/b#1', provider: 'github', repo: 'a/b', prNumber: 1, headSha: 'abcdef1', title: 't', status: 'running',
      decision: null, reason: null, rounds: 0, convergence: null, result: null, minutes: null, createdAt: new Date().toISOString(), finishedAt: null,
    });
    const mod = await Test.createTestingModule({
      imports: [AppModule.register({ busBackend: 'memory', busSecret: 's' }, { bus: new MemoryBus(), store })],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    expect((await store.getDebate('orphan'))!.status).toBe('error');
  });
});

describe('dashboard', () => {
  it('sirve HTML estático sin datos ni innerHTML, y /v1/debates/recent lista con API key', async () => {
    const { app } = await boot({ apiKey: 'k' });
    const http = request(app.getHttpServer());
    const page = await http.get('/dashboard').expect(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.text).not.toContain('innerHTML');
    await http.get('/v1/debates/recent').expect(401);
    const c = await http.post('/v1/debates').set('x-api-key', 'k').send(body(CLEAN_PR())).expect(202);
    await http.get(`/v1/debates/${c.body.id}?waitMs=5000`).set('x-api-key', 'k').expect(200);
    const recent = await http.get('/v1/debates/recent?limit=5').set('x-api-key', 'k').expect(200);
    expect(recent.body[0]).toMatchObject({ id: c.body.id, status: 'approved', repo: 'acme/shop' });
    await app.close();
  });
});
