import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CLEAN_PR, FAKE_AWS_KEY, makePr } from '../../agents/__tests__/fixtures';
import { AppModule } from '../src/app.module';
import { MemoryBus } from '../src/bus/memory_bus';
import { ScriptedProvider } from '../../agents/llm';
import { Metrics } from '../src/debate/metrics';
import { redactSecrets } from '../src/debate/redact';
import { renderMinutes } from '../src/debate/minutes';
import { MemoryStore } from '../src/store/memory_store';
import { makeHarness } from './helpers';

describe('redacción de secretos en la minuta', () => {
  it('enmascara patrones conocidos', () => {
    expect(redactSecrets(`k=${FAKE_AWS_KEY}`)).not.toContain(FAKE_AWS_KEY);
    expect(redactSecrets('token ghp_' + 'a'.repeat(36))).toContain('[REDACTADO]');
    expect(redactSecrets('password = "hunter2hunter2"')).toBe('password = "[REDACTADO]"');
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).not.toContain('MIIabc');
    expect(redactSecrets('texto normal')).toBe('texto normal');
  });

  it('la minuta de un PR con clave AWS no republica la clave', async () => {
    const h = await makeHarness();
    const pr = makePr([{ path: 'src/cfg.ts', added: [`export const KEY = "${FAKE_AWS_KEY}";`] }]);
    const md = renderMinutes(await h.engine.run('r1', pr));
    await h.stop();
    expect(md).toContain('Clave de acceso AWS');
    expect(md).not.toContain(FAKE_AWS_KEY);
    expect(md).toContain('[REDACTADO]');
  });
});

describe('concurrencia y métricas', () => {
  it('limita los debates simultáneos y expone /metrics', async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule.register({ busBackend: 'memory', busSecret: 's', maxConcurrentDebates: 1, apiKey: 'k' }, { bus: new MemoryBus(), store: new MemoryStore() })],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const http = request(app.getHttpServer());
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const pr = { ...CLEAN_PR(), number: n };
      const r = await http.post('/v1/debates').set('x-api-key', 'k').send({ pr: { provider: 'github', repo: pr.repo, number: n, title: 't', headSha: pr.headSha, diff: pr.diff } }).expect(202);
      ids.push(r.body.id);
    }
    for (const id of ids) {
      const d = await http.get(`/v1/debates/${id}?waitMs=5000`).set('x-api-key', 'k').expect(200);
      expect(d.body.status).toBe('approved');
    }
    await http.get('/metrics').expect(401);
    const m = await http.get('/metrics').set('x-api-key', 'k').expect(200);
    expect(m.text).toContain('consensus_debates_total{decision="APPROVED"} 3');
    expect(m.text).toContain('consensus_debates_active 0');
    expect(m.text).toContain('consensus_debates_queued 0');
    await app.close();
  });
});

describe('carga', () => {
  // Latencia por llamada al LLM simulado: fuerza a que los debates se solapen y se forme cola.
  const slowLlm = new ScriptedProvider(async () => {
    await new Promise((r) => setTimeout(r, 40));
    return JSON.stringify({ findings: [] });
  });

  it('24 debates con límite 3: todos terminan y nunca hay más de 3 activos a la vez', async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule.register({ busBackend: 'memory', busSecret: 's', maxConcurrentDebates: 3 }, { bus: new MemoryBus(), store: new MemoryStore(), llm: slowLlm })],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const metrics = app.get(Metrics);
    const read = (name: string) => Number(new RegExp(`${name} (\\d+)`).exec(metrics.render())![1]);
    // Se registra el máximo exacto interceptando los contadores (el muestreo por timers se ve privado de CPU).
    let active = 0;
    let queued = 0;
    let maxActive = 0;
    let maxQueued = 0;
    const origRun = metrics.debateRunning.bind(metrics);
    const origQueue = metrics.debateQueued.bind(metrics);
    metrics.debateRunning = (d: number) => {
      active += d;
      maxActive = Math.max(maxActive, active);
      origRun(d);
    };
    metrics.debateQueued = (d: number) => {
      queued += d;
      maxQueued = Math.max(maxQueued, queued);
      origQueue(d);
    };
    try {
      const http = request(app.getHttpServer());
      const diffs = [
        CLEAN_PR().diff, // aprobado (1 ronda)
        makePr([{ path: 'src/c.ts', added: [`export const K = "${FAKE_AWS_KEY}";`] }, { path: 'src/c.test.ts', added: ['t'] }]).diff, // rechazado (veto)
        makePr([{ path: 'src/db.ts', added: ['const q = `SELECT * FROM u WHERE id = ${req.params.id}`;'] }, { path: 'src/db.test.ts', added: ['t'] }]).diff, // escalado
      ];
      const ids = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          http
            .post('/v1/debates')
            .send({ pr: { provider: 'github', repo: 'acme/shop', number: i + 1, title: 't', headSha: `abc${String(i + 1).padStart(4, '0')}`, diff: diffs[i % 3] } })
            .expect(202)
            .then((r) => r.body.id as string),
        ),
      );
      const results = await Promise.all(ids.map((id) => http.get(`/v1/debates/${id}?waitMs=60000`).then((r) => r.body.status as string)));
      const count = (st: string) => results.filter((x) => x === st).length;
      expect([count('approved'), count('rejected'), count('escalated')]).toEqual([8, 8, 8]);
      expect(maxActive).toBeGreaterThan(0);
      expect(maxActive).toBeLessThanOrEqual(3);
      expect(maxQueued).toBeGreaterThan(0); // la cola se usó de verdad
      expect(read('consensus_debates_queued')).toBe(0);
      expect(read('consensus_debates_active')).toBe(0);
    } finally {
      await app.close();
    }
  }, 90000);
});
