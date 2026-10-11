/** Elimina del diff los ficheros que casan con alguno de los patrones glob (`*`, `**`, `?`). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
        // `**` al final o seguido de nombre: cualquier profundidad
        if (i === glob.length - 1) re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function filterDiff(diff: string, ignorePaths: string[]): { diff: string; ignored: string[] } {
  if (ignorePaths.length === 0) return { diff, ignored: [] };
  const matchers = ignorePaths.map(globToRegExp);
  const parts = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const part of parts) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part.split('\n', 1)[0]);
    if (!m) {
      kept.push(part);
      continue;
    }
    if (matchers.some((r) => r.test(m[2]))) ignored.push(m[2]);
    else kept.push(part);
  }
  return { diff: kept.join(''), ignored };
}
