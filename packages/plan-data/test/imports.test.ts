import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const srcDir = new URL('../src/', import.meta.url);

describe('plan-data module imports', () => {
  it('imports no fs or path module, so it works from built output moved elsewhere', () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(new URL(f, srcDir), 'utf8');
      const specs = [
        ...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g),
      ].map((m) => m[1] as string);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) {
        expect(s, `${f} imports ${s}`).not.toMatch(/^(node:)?(fs|path)(\/.*)?$/);
      }
    }
  });
});
