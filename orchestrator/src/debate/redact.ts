/**
 * Enmascara secretos antes de publicarlos en la minuta: el comentario del PR es más visible que el propio código,
 * y repetir una clave filtrada amplificaría la fuga.
 */
const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, (m) => `${m.slice(0, 4)}…[REDACTADO]`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '-----BEGIN PRIVATE KEY----- [REDACTADO]'],
  [/\b(gh[pousr]_|xox[abprs]-|sk_live_|sk-ant-|sk-)[A-Za-z0-9_-]{8,}/g, (_m, p: string) => `${p}…[REDACTADO]`],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza…[REDACTADO]'],
  [/\b((?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*)(['"])[^'"\s]{4,}\2/gi, (_m, p: string, q: string) => `${p}${q}[REDACTADO]${q}`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as never);
  return out;
}
