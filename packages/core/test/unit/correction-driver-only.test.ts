import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.[tj]sx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * D#597 CC-3: the database lets a session with no user stamp an accepted correction as applied, because the stage driver has no
 * user. packages/core/src/corrections/driver.ts is the one module built for that session (it refuses a session that names a user).
 * A request handler always has a user, and a person must not be able to stamp a run note by calling a route, so no route module
 * and no web page may import the driver module, and none may call `markCorrectionApplied` (the accept route reaches it only
 * through core's `acceptCorrection`, in the person's own session).
 */
describe('the userless correction path is the driver\'s alone (D#597 CC-3)', () => {
  const handlerDirs = [path.join(ROOT, 'packages', 'api', 'src'), path.join(ROOT, 'apps', 'web', 'app'), path.join(ROOT, 'apps', 'web', 'pages')];
  const files = handlerDirs.flatMap((d) => {
    try {
      return walk(d);
    } catch {
      // fx-swallow-ok: a directory this checkout does not have (e.g. no pages router) has nothing to scan
      return [];
    }
  });

  it('scans the request-handler trees', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(path.join('routes', 'corrections.ts')))).toBe(true);
  });

  it('no request handler imports the driver module or calls the stamp directly', () => {
    const offenders = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /corrections\/driver/.test(text) || /\bmarkCorrectionApplied\b/.test(text) || /\battachRunNotes\b/.test(text);
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
