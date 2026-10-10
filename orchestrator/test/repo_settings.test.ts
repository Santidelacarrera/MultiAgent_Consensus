import { Test } from '@nestjs/testing';
import request from 'supertest';
import { makePr } from '../../agents/__tests__/fixtures';
import { AppModule } from '../src/app.module';
import { MemoryBus } from '../src/bus/memory_bus';
import { filterDiff, globToRegExp } from '../src/debate/diff_filter';
import { InvalidPrInput, parseRepoSettings } from '../src/debate/pr_input';
import { MemoryStore } from '../src/store/memory_store';

describe('globToRegExp / filterDiff', () => {
  it('soporta *, ** y ?', () => {
    expect(globToRegExp('vendor/**').test('vendor/a/b.js')).toBe(true);
    expect(globToRegExp('**/*.min.js').test('src/x/app.min.js')).toBe(true);
    expect(globToRegExp('**/*.min.js').test('app.min.js')).toBe(true);
    expect(globToRegExp('*.lock').test('a/yarn.lock')).toBe(false);
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });

  it('elimina sólo los ficheros ignorados', () => {
    const pr = makePr([{ path: 'vendor/lib.js', added: ['eval(x);'] }, { path: 'src/ok.ts', added: ['const a = 1;'] }]);
    const { diff, ignored } = filterDiff(pr.diff, ['vendor/**']);
    expect(ignored).toEqual(['vendor/lib.js']);
    expect(diff).toContain('src/ok.ts');
    expect(diff).not.toContain('vendor/lib.js');
  });
});

describe('parseRepoSettings', () => {
  it('valida rangos', () => {
    expect(parseRepoSettings(undefined)).toEqual({});
    expect(parseRepoSettings({ monthlyBudgetUsd: 50, maxRounds: 2, ignorePaths: ['a/**'] })).toEqual({ monthlyBudgetUsd: 50, maxRounds: 2, ignorePaths: ['a/**'] });
    for (const bad of [{ maxRounds: 0 }, { maxRounds: 9 }, { monthlyBudgetUsd: -1 }, { ignorePaths: 'x' }, [], 'x'])
      expect(() => parseRepoSettings(bad)).toThrow(InvalidPrInput);
  });
});

describe('ajustes por repositorio en el debate', () => {
  const boot = async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule.register({ busBackend: 'memory', busSecret: 's' }, { bus: new MemoryBus(), store: new MemoryStore() })] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    return app;
  };
  const send = (pr: ReturnType<typeof makePr>, settings?: object) => ({ pr: { provider: 'github', repo: pr.repo, number: pr.number, title: 't', headSha: pr.headSha, diff: pr.diff }, settings });

  it('el presupuesto del repo cambia la severidad del coste', async () => {
    const app = await boot();
    const http = request(app.getHttpServer());
    const mk = (n: number) => ({ ...makePr([{ path: 'infra/main.tf', removed: ['  instance_type = "m5.large"'], added: ['  instance_type = "m5.4xlarge"'] }]), number: n });
    const loose = await http.post('/v1/debates').send(send(mk(1))).expect(202); // presupuesto 1000: +$490 → medium
    const tight = await http.post('/v1/debates').send(send(mk(2), { monthlyBudgetUsd: 100 })).expect(202); // +$490 ≥ 100 → high
    const sev = async (id: string) => (await http.get(`/v1/debates/${id}?waitMs=5000&full=true`)).body.result.rounds[0].reviews.find((r: { agent: string }) => r.agent === 'business_ops').findings.find((f: { category: string }) => f.category === 'cost').severity;
    expect(await sev(loose.body.id)).toBe('medium');
    expect(await sev(tight.body.id)).toBe('high');
    await app.close();
  });

  it('ignorePaths excluye ficheros del debate y lo registra; maxRounds limita las rondas', async () => {
    const app = await boot();
    const http = request(app.getHttpServer());
    const pr = makePr([{ path: 'vendor/x.js', added: ['eval(x);'] }, { path: 'src/db.ts', added: ['const q = `SELECT * FROM u WHERE id = ${req.params.id}`;'] }, { path: 'src/db.test.ts', added: ['t'] }]);
    const r = await http.post('/v1/debates').send(send(pr, { ignorePaths: ['vendor/**'], maxRounds: 2 })).expect(202);
    const d = (await http.get(`/v1/debates/${r.body.id}?waitMs=5000&full=true`)).body;
    expect(d.status).toBe('escalated');
    expect(d.rounds).toBe(2);
    const findings = d.result.rounds[0].reviews.flatMap((x: { findings: { id: string }[] }) => x.findings.map((f) => f.id));
    expect(findings.some((id: string) => id.includes('vendor'))).toBe(false);
    const events = (await http.get(`/v1/debates/${r.body.id}/events`)).body;
    expect(events.find((e: { type: string }) => e.type === 'diff.filtered').payload.ignored).toEqual(['vendor/x.js']);
    await http.post('/v1/debates').send(send(pr, { maxRounds: 99 })).expect(400);
    await app.close();
  });
});
