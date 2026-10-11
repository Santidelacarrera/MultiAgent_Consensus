import { loadConfig } from '../src/config';
import { InvalidPrInput, parsePullRequest } from '../src/debate/pr_input';

describe('loadConfig', () => {
  it('valores por defecto', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 3000, busBackend: 'redis', agentTimeoutMs: 120000, monthlyBudgetUsd: 1000 });
    expect(c.policy).toMatchObject({ maxRounds: 3, vetoOnCritical: true });
    expect(c.databaseUrl).toBeUndefined();
  });
  it('lee el entorno y valida', () => {
    const c = loadConfig({ PORT: '8080', BUS_BACKEND: 'memory', MAX_ROUNDS: '5', VETO_ON_CRITICAL: 'false', DATABASE_URL: 'postgres://x', MONTHLY_BUDGET_USD: '250' });
    expect(c).toMatchObject({ port: 8080, busBackend: 'memory', databaseUrl: 'postgres://x', monthlyBudgetUsd: 250 });
    expect(c.policy).toMatchObject({ maxRounds: 5, vetoOnCritical: false });
    expect(() => loadConfig({ BUS_BACKEND: 'kafka' })).toThrow(/BUS_BACKEND/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/numérico/);
    expect(() => loadConfig({ MAX_ROUNDS: '0' })).toThrow(/MAX_ROUNDS/);
  });
});

describe('parsePullRequest', () => {
  const ok = { provider: 'github', repo: 'acme/shop', number: 7, title: 'T', headSha: 'ABCDEF1234', diff: 'diff --git a/a b/a\n' };
  it('normaliza e ignora id externo', () => {
    const pr = parsePullRequest({ ...ok, id: 'evil' });
    expect(pr.id).toBe('github:acme/shop#7');
    expect(pr.headSha).toBe('abcdef1234');
  });
  it.each([
    [{ ...ok, provider: 'svn' }],
    [{ ...ok, repo: 'a b' }],
    [{ ...ok, number: 1.5 }],
    [{ ...ok, headSha: 'xyz' }],
    [{ ...ok, diff: 5 }],
    [null],
  ])('rechaza entradas inválidas %#', (bad) => {
    expect(() => parsePullRequest(bad)).toThrow(InvalidPrInput);
  });
});
