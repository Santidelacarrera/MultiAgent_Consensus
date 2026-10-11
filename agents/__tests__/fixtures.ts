import { PullRequestContext } from '../protocol';

export interface FileSpec {
  path: string;
  /** Líneas añadidas (hunk contiguo desde `startLine`). */
  added?: string[];
  removed?: string[];
  startLine?: number;
  isNew?: boolean;
}

/** Construye un diff unificado sintético a partir de especificaciones simples. */
export function makeDiff(files: FileSpec[]): string {
  const out: string[] = [];
  for (const f of files) {
    const added = f.added ?? [];
    const removed = f.removed ?? [];
    const start = f.startLine ?? 1;
    out.push(`diff --git a/${f.path} b/${f.path}`);
    if (f.isNew) out.push('new file mode 100644');
    out.push(`--- ${f.isNew ? '/dev/null' : `a/${f.path}`}`, `+++ b/${f.path}`);
    out.push(`@@ -${start},${removed.length} +${start},${added.length} @@`);
    for (const r of removed) out.push(`-${r}`);
    for (const a of added) out.push(`+${a}`);
  }
  return out.join('\n') + '\n';
}

export function makePr(files: FileSpec[], over: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    id: 'local:acme/shop#42',
    provider: 'local',
    repo: 'acme/shop',
    number: 42,
    title: 'Test PR',
    headSha: 'a'.repeat(40),
    diff: makeDiff(files),
    ...over,
  };
}

export const CLEAN_PR = (): PullRequestContext =>
  makePr([
    { path: 'src/util/math.ts', isNew: true, added: ['export function add(a: number, b: number): number {', '  return a + b;', '}'] },
    { path: 'src/util/math.test.ts', isNew: true, added: ["import { add } from './math';", "test('add', () => expect(add(1, 2)).toBe(3));"] },
  ]);

// Concatenado para que el propio repo no contenga un secreto detectable.
export const FAKE_AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
