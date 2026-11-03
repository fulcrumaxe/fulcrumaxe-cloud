import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.join(HERE, '..', '..');
const WEB = path.join(PACKAGES, '..', 'apps', 'web');
const read = (file: string) => readFileSync(file, 'utf8');
const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(path.join(dir, e.name)) : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []));
/** Every module specifier a file imports or re-exports from. */
const specifiers = (src: string): string[] => [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const ASSISTANT_SPEC = /(^|\/)assistant(\/|$)|@fx\/model-call|model-call\/src/;

/** D#597 CC-5e: the assistant is a leaf. Its tools read in-process (R-597-C2-3), and the work-item driver neither imports nor awaits anything of it (CC-5e-9). */
describe('assistant import graph', () => {
  it('R-597-C2-3: no assistant module (the tool registry, the turn loop, the stream) calls fetch; only @fx/model-call reaches the network', () => {
    const files = [...tsFiles(path.join(PACKAGES, 'core', 'src', 'assistant')), ...tsFiles(path.join(PACKAGES, 'api', 'src', 'assistant'))];
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bfetch\s*\(/);
      expect(src, f).not.toMatch(/globalThis\.fetch|node:https?|undici/);
    }
    // The route's file may hold an injected transport for tests, never call one.
    expect(read(path.join(PACKAGES, 'api', 'src', 'routes', 'assistant.ts'))).not.toMatch(/\bfetch\s*\(/);
  });

  it('the turn loop imports no writer other than the registry: no accept, reject, stage verb, halt or merge module', () => {
    const src = read(path.join(PACKAGES, 'api', 'src', 'assistant', 'turn.ts'));
    for (const s of specifiers(src)) expect(s, s).not.toMatch(/corrections\/(index|accept|decide)|stage|halt|merge|run-actions|work-item-actions|pipeline|worker/i);
  });

  it('workItemAdvance reaches nothing of the assistant: its whole relative import closure in apps/web is clean, and so are the worker and pipeline sources', () => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      for (const s of specifiers(read(file))) {
        if (ASSISTANT_SPEC.test(s)) throw new Error(`${path.relative(WEB, file)} imports ${s}`);
        if (!s.startsWith('.')) continue;
        const base = path.resolve(path.dirname(file), s.replace(/\.js$/, ''));
        walk([base + '.ts', path.join(base, 'index.ts')].find(existsSync) ?? base + '.ts');
      }
    };
    walk(path.join(WEB, 'workflows', 'workItemAdvance.ts'));
    expect(seen.size).toBeGreaterThan(5);
    for (const pkg of ['worker', 'pipeline']) {
      for (const f of tsFiles(path.join(PACKAGES, pkg, 'src'))) for (const s of specifiers(read(f))) expect(s, `${pkg}: ${path.relative(PACKAGES, f)}`).not.toMatch(ASSISTANT_SPEC);
    }
  });
});
