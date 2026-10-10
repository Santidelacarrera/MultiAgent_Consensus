import { ConsensusPolicy, DEFAULT_POLICY } from './types';

export interface AppConfig {
  port: number;
  busBackend: 'redis' | 'memory';
  redisUrl: string;
  /** Si no hay DATABASE_URL se usa almacenamiento en memoria. */
  databaseUrl?: string;
  apiKey?: string;
  /** Secreto del que se derivan las claves HMAC por agente. */
  busSecret: string;
  agentTimeoutMs: number;
  monthlyBudgetUsd: number;
  /** Retención (s) de los streams Redis por debate una vez concluido. */
  streamTtlSeconds: number;
  policy: ConsensusPolicy;
  env: Record<string, string | undefined>;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`valor numérico inválido: ${v}`);
  return n;
};

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const backend = (env.BUS_BACKEND ?? 'redis').toLowerCase();
  if (backend !== 'redis' && backend !== 'memory') throw new Error(`BUS_BACKEND inválido: ${backend}`);
  const cfg: AppConfig = {
    port: num(env.PORT, 3000),
    busBackend: backend,
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    databaseUrl: env.DATABASE_URL || undefined,
    apiKey: env.ORCHESTRATOR_API_KEY || undefined,
    busSecret: env.BUS_SECRET ?? 'dev-only-bus-secret-change-me',
    agentTimeoutMs: num(env.AGENT_TIMEOUT_MS, 120_000),
    monthlyBudgetUsd: num(env.MONTHLY_BUDGET_USD, 1000),
    streamTtlSeconds: num(env.STREAM_TTL_SECONDS, 7 * 86_400),
    policy: {
      ...DEFAULT_POLICY,
      maxRounds: num(env.MAX_ROUNDS, DEFAULT_POLICY.maxRounds),
      vetoOnCritical: (env.VETO_ON_CRITICAL ?? 'true').toLowerCase() !== 'false',
    },
    env,
  };
  if (cfg.policy.maxRounds < 1) throw new Error('MAX_ROUNDS debe ser >= 1');
  if (process.env.NODE_ENV === 'production' && cfg.busSecret === 'dev-only-bus-secret-change-me') {
    throw new Error('BUS_SECRET debe configurarse en producción');
  }
  return { ...cfg, ...overrides, policy: { ...cfg.policy, ...(overrides.policy ?? {}) } };
}
