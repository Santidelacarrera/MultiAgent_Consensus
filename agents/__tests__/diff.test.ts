import { parseDiff, isTestPath } from '../diff';
import { makeDiff } from './fixtures';

describe('parseDiff', () => {
  it('extrae líneas añadidas/eliminadas con su número', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,3 +10,4 @@ fn',
      ' ctx',
      '-old',
      '+new1',
      '+new2',
      ' ctx2',
    ].join('\n');
    const [f] = parseDiff(diff);
    expect(f.path).toBe('a.ts');
    expect(f.removed).toEqual([{ line: 11, text: 'old' }]);
    expect(f.added).toEqual([
      { line: 11, text: 'new1' },
      { line: 12, text: 'new2' },
    ]);
  });

  it('detecta ficheros nuevos y múltiples ficheros', () => {
    const files = parseDiff(makeDiff([{ path: 'x.py', isNew: true, added: ['a', 'b'] }, { path: 'y.py', added: ['c'], removed: ['d'] }]));
    expect(files.map((f) => [f.path, f.status])).toEqual([['x.py', 'added'], ['y.py', 'modified']]);
  });

  it('soporta diffs sin cabecera diff --git (GitLab)', () => {
    const [f] = parseDiff('--- a/z.go\n+++ b/z.go\n@@ -1 +1 @@\n-a\n+b\n');
    expect(f.path).toBe('z.go');
    expect(f.added[0].text).toBe('b');
  });

  it('no confunde "+++ " dentro de un hunk con cabecera', () => {
    const [f] = parseDiff(makeDiff([{ path: 'a.md', added: ['++ not header', '--- not header'] }]));
    expect(f.added.length).toBe(2);
  });

  it('clasifica rutas de test', () => {
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('tests/test_a.py')).toBe(true);
    expect(isTestPath('src/a.ts')).toBe(false);
  });
});
