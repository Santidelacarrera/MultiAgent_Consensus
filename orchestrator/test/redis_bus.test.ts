import { CLEAN_PR, FAKE_AWS_KEY, makePr } from '../../agents/__tests__/fixtures';
import { RedisStreamsBus } from '../src/bus/redis_bus';
import { renderMinutes } from '../src/debate/minutes';
import { makeHarness, Harness } from './helpers';
import { RedisHandle, startRedis } from './redis_helper';

let redis: RedisHandle | null;
beforeAll(async () => {
  redis = await startRedis();
  if (!redis) console.warn('redis-server no disponible: se omiten los tests de integración con Redis Streams');
}, 15000);
afterAll(async () => redis?.stop());

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!redis) return;
    await fn();
  });

describe('RedisStreamsBus (redis-server real)', () => {
  maybe('publica y consume con consumer groups (cada mensaje a un único consumidor)', async () => {
    const bus = new RedisStreamsBus(redis!.url, 100);
    const got: Record<string, string[]> = { a: [], b: [] };
    const sa = await bus.subscribe('t:stream', { group: 'g', consumer: 'a' }, async (m) => void got.a.push(m.data.n as string));
    const sb = await bus.subscribe('t:stream', { group: 'g', consumer: 'b' }, async (m) => void got.b.push(m.data.n as string));
    for (let i = 0; i < 10; i++) await bus.publish('t:stream', { n: String(i) });
    for (let i = 0; i < 50 && got.a.length + got.b.length < 10; i++) await new Promise((r) => setTimeout(r, 50));
    expect([...got.a, ...got.b].sort()).toEqual(Array.from({ length: 10 }, (_, i) => String(i)).sort());
    expect((await bus.history('t:stream')).length).toBe(10);
    await sa.stop();
    await sb.stop();
    await bus.close();
  });

  maybe('un grupo distinto recibe todo el stream (fan-out) y los fallos se reintentan', async () => {
    const bus = new RedisStreamsBus(redis!.url, 100);
    let tries = 0;
    const seen: unknown[] = [];
    const s1 = await bus.subscribe('t:retry', { group: 'g1', consumer: 'c', maxDeliveries: 3 }, async (m) => {
      if (++tries < 2) throw new Error('boom');
      seen.push(m.data.k);
    });
    const other: unknown[] = [];
    const s2 = await bus.subscribe('t:retry', { group: 'g2', consumer: 'c' }, async (m) => void other.push(m.data.k));
    await bus.publish('t:retry', { k: 'v' });
    for (let i = 0; i < 60 && (seen.length < 1 || other.length < 1); i++) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['v']);
    expect(tries).toBe(2);
    expect(other).toEqual(['v']);
    await s1.stop();
    await s2.stop();
    await bus.close();
  });
});

describe('Debate completo sobre Redis Streams', () => {
  let h: Harness | undefined;
  afterEach(async () => h?.stop());

  maybe('PR limpio → APPROVED; el log del debate queda en los streams', async () => {
    h = await makeHarness({}, undefined, new RedisStreamsBus(redis!.url, 100));
    const r = await h.engine.run('redis-1', CLEAN_PR());
    expect(r.decision).toBe('APPROVED');
    const resp = await h.bus.history('mac:debate:redis-1:responses');
    expect(resp).toHaveLength(3);
    const reqs = await h.bus.history('mac:agent:architect:requests');
    expect(reqs.length).toBeGreaterThanOrEqual(1);
  });

  maybe('secreto → debate multi-turn y RECHAZO por veto', async () => {
    h = await makeHarness({}, undefined, new RedisStreamsBus(redis!.url, 100));
    const pr = makePr([{ path: 'src/cfg.ts', added: [`export const KEY = "${FAKE_AWS_KEY}";`] }, { path: 'src/cfg.test.ts', added: ['t'] }]);
    const r = await h.engine.run('redis-2', pr);
    expect(r.decision).toBe('REJECTED');
    expect(r.rounds).toHaveLength(2);
    expect(renderMinutes(r)).toContain('Veto de seguridad');
  });
});

describe('retención de streams', () => {
  it('expire() programa la expiración del stream en Redis', async () => {
    if (!redis) return;
    const bus = new RedisStreamsBus(redis.url, 100);
    await bus.publish('t:ttl', { a: 1 });
    await bus.expire('t:ttl', 1);
    expect((await bus.history('t:ttl')).length).toBe(1);
    await new Promise((r) => setTimeout(r, 1300));
    expect((await bus.history('t:ttl')).length).toBe(0);
    await bus.close();
  });
});
