import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DP8 / DP-C6 criteria 9 and 12 (static). Every non-test call of `recordStage`, `setStage` and `publishSpec` under
 * packages/** and apps/** is listed here with what it does about a customer halt. A file that is not on the list fails: adding
 * a stage writer means deciding, here, what it does while the item is halted.
 */
const ROOT = resolve(__dirname, '../../../..');

/** A writer either names WorkItemHaltedError (it maps the refusal) or is exempt for the reason given. */
const EXEMPT: Readonly<Record<string, string>> = {
  'packages/core/src/work-items/operatorMoves.ts': "a person's move (actor: 'person')",
  'packages/worker/src/runActions.ts': "the halt's own park, a move INTO needs_human",
  'packages/github/src/eventMapper.ts': 'a webhook fact about GitHub (source: webhook), recorded while halted',
  'packages/api/scripts/seed-dev.ts': 'a developer seed script, never run against a customer item',
  'packages/discussions/src/stages.ts': "library setStage: passes the principal's actor and lets the refusal reach its caller (triage maps it)",
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'test' || name === 'tests' || name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
}

function writers(): string[] {
  const files: string[] = [];
  walk(join(ROOT, 'packages'), files);
  walk(join(ROOT, 'apps'), files);
  const calls = /(^|[^A-Za-z0-9_.])(recordStage|setStage|publishSpec)\(/m;
  return files
    .filter((f) => {
      const src = readFileSync(f, 'utf8');
      // A declaration (`function setStage(`, `async function recordStage(`) is not a call; look for a call elsewhere in the file.
      return src.split('\n').some((line) => calls.test(line) && !/function\s+(recordStage|setStage|publishSpec)\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/`[^`]*\b(recordStage|setStage|publishSpec)\(/.test(line));
    })
    .map((f) => relative(ROOT, f))
    .sort();
}

describe('every stage writer decides what it does while an item is halted (DP-C6 criterion 9)', () => {
  const found = writers();

  it('finds the writers at all (the scan is not vacuous)', () => {
    expect(found.length).toBeGreaterThanOrEqual(14);
    expect(found).toContain('packages/worker/src/advance.ts');
    expect(found).toContain('packages/pipeline/src/build/fixLoop.ts');
  });

  it('each writer names WorkItemHaltedError or is on the exempt list with a reason', () => {
    const undecided = found.filter((f) => !(f in EXEMPT) && !/WorkItemHaltedError|RunWorkItemHaltedError|StageHaltedError/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(undecided).toEqual([]);
  });

  it('every exempt entry is still a writer (no stale exemptions)', () => {
    for (const f of Object.keys(EXEMPT)) expect(found, f).toContain(f);
  });

  it("recordStage defaults the actor to 'automatic', so a writer added later is covered", () => {
    const src = readFileSync(join(ROOT, 'packages/core/src/work-items/recordStage.ts'), 'utf8');
    expect(src).toMatch(/actor = 'automatic'/);
    expect(src).not.toMatch(/actor = 'person'/);
  });
});

describe('the #34 stage-based design stays removed (DP-C6 criterion 12)', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const sources = ['packages/worker/src/advance.ts', 'packages/worker/src/runActions.ts', 'packages/worker/src/retry.ts', 'packages/pipeline/src/advance/followedRunner.ts'];

  it('has no re-list loop, no straggler stopper, no stage-based start refusal and no userId on the start request', () => {
    for (const p of sources) {
      const src = read(p);
      for (const gone of ['MAX_RELIST_PASSES', 'itemIsHalted', 'stopStraggler', 'stage_needs_human']) expect(src, `${p} ${gone}`).not.toContain(gone);
    }
    const advance = read('packages/worker/src/advance.ts');
    const req = advance.slice(advance.indexOf('export interface AdvanceRunRequest'), advance.indexOf('export type AdvanceRunStart'));
    expect(req).not.toMatch(/userId/);
    expect(req).toMatch(/haltEpoch: number;/);
  });

  it('no comment calls the lost-run sweep a backstop for a run that is live', () => {
    expect(read('packages/pipeline/src/advance/followedRunner.ts')).toMatch(/not a backstop for a live one/);
    for (const p of sources) {
      const lines = read(p).split('\n').filter((l) => /sweep/i.test(l) && /backstop/i.test(l));
      // The only mention allowed is the one that says the sweep is NOT one.
      for (const l of lines) expect(l, p).toMatch(/not a backstop/);
    }
  });
});
