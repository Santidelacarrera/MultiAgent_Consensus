import { FileChange } from './protocol';

/** Parsea un diff unificado (git diff / GitLab changes) en cambios por fichero. */
export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let gitHeader = false; // vimos `diff --git` y aún no consumimos su ---/+++

  const lines = diff.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inHunk = oldRemaining > 0 || newRemaining > 0;

    if (inHunk) {
      // Dentro de un hunk el prefijo decide: '+++'/'---' son contenido si el contador lo exige.
      if (line.startsWith('+')) {
        current!.added.push({ line: newLine++, text: line.slice(1) });
        newRemaining--;
      } else if (line.startsWith('-')) {
        current!.removed.push({ line: oldLine++, text: line.slice(1) });
        oldRemaining--;
      } else if (line.startsWith(' ') || line === '') {
        oldLine++;
        newLine++;
        oldRemaining--;
        newRemaining--;
      }
      // '\ No newline at end of file' no consume contadores
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: m ? m[2] : line.slice(11), status: 'modified', added: [], removed: [] };
      files.push(current);
      gitHeader = true;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const plus = lines[i + 1].slice(4);
      if (!gitHeader) {
        current = { path: stripPrefix(plus), status: 'modified', added: [], removed: [] };
        files.push(current);
      }
      if (line.startsWith('--- /dev/null')) current!.status = 'added';
      if (plus === '/dev/null') current!.status = 'deleted';
      else current!.path = stripPrefix(plus);
      gitHeader = false;
      i++;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename to ')) {
      current.status = 'renamed';
      current.path = line.slice(10);
    }

    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      oldLine = parseInt(h[1], 10);
      newLine = parseInt(h[3], 10);
      oldRemaining = h[2] === undefined ? 1 : parseInt(h[2], 10);
      newRemaining = h[4] === undefined ? 1 : parseInt(h[4], 10);
    }
  }
  return files;
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '').trim();
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i.test(path);
}

export function isDocPath(path: string): boolean {
  return /\.(md|mdx|rst|txt|adoc)$/i.test(path) || /(^|\/)(docs?|examples?|samples?|fixtures?)(\/|$)/i.test(path);
}

export function isSourcePath(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|cs|php|scala|swift)$/i.test(path) && !isTestPath(path);
}

export function isInfraPath(path: string): boolean {
  return (
    /\.(tf|tfvars|hcl)$/i.test(path) ||
    /(^|\/)(k8s|kubernetes|helm|charts?|deploy|infra|terraform|manifests?)(\/|$)/i.test(path) ||
    /(^|\/)(docker-compose[^/]*\.ya?ml|Dockerfile[^/]*|serverless\.ya?ml|template\.ya?ml|cloudformation[^/]*\.(ya?ml|json))$/i.test(path) ||
    /\.(ya?ml)$/i.test(path)
  );
}

/** Todas las líneas añadidas del PR unidas, para comprobar evidencia literal. */
export function addedText(files: FileChange[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) out.set(f.path, f.added.map((l) => l.text).join('\n'));
  return out;
}
