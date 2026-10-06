import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    ['node_modules', 'dist', '.next', '.claude'].includes(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('S2b / import boundary lint', () => {
  it('only @fx/model-call imports @fx/model-connection/keyAccess, and index.ts does not re-export it', () => {
    const importers = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps'))]
      .filter((f) => /(from|import)\s*\(?\s*['"][^'"]*keyAccess(\.js)?['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f))
      .filter((f) => !f.startsWith('packages/model-call/'));
    expect(importers).toEqual([]);
    expect(read('packages/model-connection/src/index.ts')).not.toMatch(/keyAccess|withOpenedKey/);
  });

  it('no module-scope mutable state in the key-handling modules', () => {
    const files = [...walk(join(ROOT, 'packages/model-call/src')), join(ROOT, 'packages/model-connection/src/keyAccess.ts')];
    expect(files.length).toBeGreaterThanOrEqual(5);
    const state = /^(export\s+)?(let|var)\s|^(export\s+)?const\s.*=\s*(new\s+(Map|Set|WeakMap|WeakSet)\b|\{\}|\[\]|Object\.create\()/;
    for (const f of files) {
      const bad = readFileSync(f, 'utf8').split('\n').filter((l) => state.test(l));
      expect({ f: relative(ROOT, f), bad }).toEqual({ f: relative(ROOT, f), bad: [] });
    }
  });
});
