import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ASK-WIRE-1 guard: an ask raised without `raiseAskMarked` never tells the cron gate when its answer window ends, so it waits for the backstop.
 * Non-test code may call the raw raise (`raiseAsk` / `decision_ask_raise`) only inside the db package that defines it and raiseAskMarked itself.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ALLOWED = new Set(['packages/db/src/decisionAsks.ts', 'packages/core/src/decisions/raiseAskMarked.ts']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__', '.git', '.claude', 'migrations']);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|sql|sh)$/;
const TEST_FILE = /\.(test|spec)\.|\.d\.ts$/;
const RAW_CALL = /\braiseAsk\b|\bdecision_ask_raise\b/;

/** Code with comments removed, so prose that names the function is not a call. Strings stay: the SQL text is the other way to reach it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1').replace(/^\s*--.*$/gm, '').replace(/^\s*#.*$/gm, '');
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
}

describe('raw ask raise guard', () => {
  it('the matcher sees a call and ignores a comment', () => {
    expect(RAW_CALL.test(stripComments('await raiseAsk(client, input);'))).toBe(true);
    expect(RAW_CALL.test(stripComments("client.query('SELECT decision_ask_raise($1)')"))).toBe(true);
    expect(RAW_CALL.test(stripComments('// raiseAsk is wrapped\n/* decision_ask_raise */ const a = 1;'))).toBe(false);
  });

  it('no non-test code outside raiseAskMarked reaches the raw raise', () => {
    const files: string[] = [];
    for (const top of ['packages', 'apps']) walk(join(ROOT, top), files);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => RAW_CALL.test(stripComments(readFileSync(join(ROOT, rel), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
