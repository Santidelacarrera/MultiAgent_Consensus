import { PullRequestContext } from '../../../agents/protocol';

export class InvalidPrInput extends Error {}

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
