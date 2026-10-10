import { readFileSync } from 'fs';
import { join } from 'path';
import { newDb } from 'pg-mem';
import { CLEAN_PR } from '../../agents/__tests__/fixtures';
import { PgStore, SCHEMA_SQL } from '../src/store/pg_store';
import { MemoryStore } from '../src/store/memory_store';
import { DebateStore } from '../src/store/store';
import { renderMinutes } from '../src/debate/minutes';
import { DebateRecord } from '../src/types';
import { makeHarness } from './helpers';

const rec = (over: Partial<DebateRecord> = {}): DebateRecord => ({
  id: 'd1', prId: 'github:a/b#1', provider: 'github', repo: 'a/b', prNumber: 1, headSha: 'abcdef1', title: 'T', status: 'running',
  decision: null, reason: null, rounds: 0, convergence: null, result: null, minutes: null, createdAt: '2026-01-01T00:00:00.000Z', finishedAt: null, ...over,
});

const stores: [string, () => Promise<DebateStore>][] = [
  ['MemoryStore', async () => new MemoryStore()],
  [
    'PgStore (pg-mem)',
    async () => {
      const { Pool } = newDb().adapters.createPg();
      return new PgStore(new Pool());
    },
  ],
];

describe.each(stores)('%s — contrato DebateStore', (_name, make) => {
  let store: DebateStore;
  beforeEach(async () => {
    store = await make();
    await store.init();
  });
  afterEach(async () => store.close());

  it('upsert y lectura de debates con minuta y resultado', async () => {
    const h = await makeHarness();
    const result = await h.engine.run('d1', CLEAN_PR());
    await h.stop();
    await store.saveDebate(rec());
    expect((await store.getDebate('d1'))!.status).toBe('running');
    const minutes = renderMinutes(result);
    await store.saveDebate(rec({ status: 'approved', decision: 'APPROVED', reason: 'ok', rounds: 1, convergence: 1, result, minutes, finishedAt: '2026-01-01T00:01:00.000Z' }));
    const got = (await store.getDebate('d1'))!;
    expect(got).toMatchObject({ status: 'approved', decision: 'APPROVED', rounds: 1, convergence: 1, minutes, finishedAt: '2026-01-01T00:01:00.000Z' });
    expect(got.result!.decision).toBe('APPROVED');
    expect(got.result!.rounds[0].reviews).toHaveLength(3);
    expect(await store.getDebate('missing')).toBeNull();
  });

  it('histórico por PR (orden descendente) y búsqueda por commit', async () => {
    await store.saveDebate(rec({ id: 'a', headSha: 'aaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.saveDebate(rec({ id: 'b', headSha: 'bbbbbbb', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.saveDebate(rec({ id: 'c', prId: 'github:a/b#2', prNumber: 2, headSha: 'ccccccc', createdAt: '2026-01-03T00:00:00.000Z' }));
    expect((await store.listByPr('github:a/b#1')).map((r) => r.id)).toEqual(['b', 'a']);
    expect((await store.findByPrAndSha('github:a/b#1', 'aaaaaaa'))!.id).toBe('a');
    expect(await store.findByPrAndSha('github:a/b#1', 'zzzzzzz')).toBeNull();
    expect((await store.listRecent(2)).map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('log de eventos ordenado y métricas de convergencia por ronda (upsert)', async () => {
    await store.saveDebate(rec());
    await store.appendEvent('d1', 'debate.started', { x: 1 }, '2026-01-01T00:00:00.000Z');
    await store.appendEvent('d1', 'round.evaluated', { round: 1 }, '2026-01-01T00:00:01.000Z');
    const ev = await store.listEvents('d1');
    expect(ev.map((e) => e.type)).toEqual(['debate.started', 'round.evaluated']);
    expect(ev[0].payload).toEqual({ x: 1 });
    await store.saveMetric({ debateId: 'd1', round: 1, convergence: 0.7, approvals: 2, rejections: 1, outcome: 'CONTINUE' });
    await store.saveMetric({ debateId: 'd1', round: 2, convergence: 0.9, approvals: 3, rejections: 0, outcome: 'APPROVED' });
    await store.saveMetric({ debateId: 'd1', round: 1, convergence: 0.75, approvals: 2, rejections: 1, outcome: 'CONTINUE' });
    expect((await store.listMetrics('d1')).map((m) => [m.round, m.convergence])).toEqual([[1, 0.75], [2, 0.9]]);
  });
});

describe('esquema SQL', () => {
  it('db/init.sql coincide con el esquema aplicado por PgStore', () => {
    const norm = (s: string) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
    const file = readFileSync(join(__dirname, '../../db/init.sql'), 'utf8');
    expect(norm(file)).toBe(norm(SCHEMA_SQL));
  });

  it('todas las sentencias DDL son idempotentes (IF NOT EXISTS)', () => {
    // pg-mem no soporta re-ejecutar CREATE ... IF NOT EXISTS, así que se verifica de forma estática.
    const ddl = SCHEMA_SQL.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
    expect(ddl.length).toBeGreaterThanOrEqual(7);
    for (const stmt of ddl) expect(stmt).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/);
  });
});
