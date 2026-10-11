import { PullRequestContext } from '../../../agents/protocol';

export class InvalidPrInput extends Error {}

export interface RepoSettings {
  monthlyBudgetUsd?: number;
  maxRounds?: number;
  ignorePaths?: string[];
}

/** Valida los ajustes por repositorio (cualquier valor fuera de rango se rechaza, no se recorta en silencio). */
export function parseRepoSettings(raw: unknown): RepoSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidPrInput('settings debe ser un objeto');
  const o = raw as Record<string, unknown>;
  const out: RepoSettings = {};
  if (o.monthlyBudgetUsd !== undefined) {
    if (typeof o.monthlyBudgetUsd !== 'number' || !(o.monthlyBudgetUsd > 0) || o.monthlyBudgetUsd > 1e8) throw new InvalidPrInput('settings.monthlyBudgetUsd inválido');
    out.monthlyBudgetUsd = o.monthlyBudgetUsd;
  }
  if (o.maxRounds !== undefined) {
    if (typeof o.maxRounds !== 'number' || !Number.isInteger(o.maxRounds) || o.maxRounds < 1 || o.maxRounds > 5) throw new InvalidPrInput('settings.maxRounds debe estar entre 1 y 5');
    out.maxRounds = o.maxRounds;
  }
  if (o.ignorePaths !== undefined) {
    if (!Array.isArray(o.ignorePaths) || o.ignorePaths.length > 50 || o.ignorePaths.some((x) => typeof x !== 'string' || !x || x.length > 200)) throw new InvalidPrInput('settings.ignorePaths inválido');
    out.ignorePaths = o.ignorePaths as string[];
  }
  return out;
}

const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/** Valida y normaliza el cuerpo de un PR recibido por HTTP (no se confía en `id`). */
export function parsePullRequest(raw: unknown): PullRequestContext {
  if (typeof raw !== 'object' || raw === null) throw new InvalidPrInput('pr debe ser un objeto');
  const o = raw as Record<string, unknown>;
  const provider = o.provider;
  if (provider !== 'github' && provider !== 'gitlab' && provider !== 'local') throw new InvalidPrInput("provider debe ser 'github', 'gitlab' o 'local'");
  if (typeof o.repo !== 'string' || !/^[\w.\-/]{1,200}$/.test(o.repo)) throw new InvalidPrInput('repo inválido');
  if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number < 0) throw new InvalidPrInput('number inválido');
  if (typeof o.title !== 'string') throw new InvalidPrInput('title es obligatorio');
  if (typeof o.headSha !== 'string' || !/^[0-9a-fA-F]{7,64}$/.test(o.headSha)) throw new InvalidPrInput('headSha inválido');
  if (typeof o.diff !== 'string') throw new InvalidPrInput('diff es obligatorio');
  if (Buffer.byteLength(o.diff) > MAX_DIFF_BYTES) throw new InvalidPrInput('diff demasiado grande');
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    id: `${provider}:${o.repo}#${o.number}`,
    provider,
    repo: o.repo,
    number: o.number,
    title: o.title.slice(0, 500),
    description: str(o.description)?.slice(0, 10_000),
    author: str(o.author)?.slice(0, 200),
    baseBranch: str(o.baseBranch)?.slice(0, 200),
    headSha: o.headSha.toLowerCase(),
    diff: o.diff,
    labels: Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === 'string').slice(0, 50) : undefined,
  };
}
