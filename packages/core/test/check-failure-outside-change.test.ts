import { describe, expect, it } from 'vitest';
import { CHECK_HEADER_END } from '@fulcrumaxe/runner-protocol';
import { checkFailureFiles, failedOutsideChange, importLinkedFailedFiles } from '../src/work-items/checkFailure.js';

const tail = '\nsome output tail\n';

describe('failedOutsideChange against the chain first check', () => {
  const first = 'failed test files (2): packages/a/test/a.test.ts, apps/ops/test/o.test.ts\nchanged files (1): packages/a/src/a.ts\nFAIL x';
  const later = 'failed test files (1): apps/ops/test/o.test.ts\nchanged files (2): apps/ops/src/o.ts, packages/a/src/a.ts\nFAIL x';
  it('a package only a later round edited is not part of the change', () => {
    expect(failedOutsideChange(later)).toBe(false);
    expect(failedOutsideChange(later, first)).toBe(true);
  });
  it('a file the later check itself lists as changed is inside the change: a regenerated file in an untouched package is not falsely stopped', () => {
    const regenerated = 'failed test files (1): apps/ops/src/generated/client.test.ts\nchanged files (2): apps/ops/src/generated/client.test.ts, packages/a/src/a.ts\nFAIL x';
    expect(failedOutsideChange(regenerated, first)).toBe(false);
    // only the file itself counts, not a sibling in the same package
    expect(failedOutsideChange(later, first)).toBe(true);
    // a later list that was cut cannot vouch for any file
    const cut = 'failed test files (1): apps/ops/src/generated/client.test.ts\nchanged files (9): apps/ops/src/generated/client.test.ts, packages/a/src/a.ts (and 7 more)\nFAIL x';
    expect(failedOutsideChange(cut, first)).toBe(true);
  });
  it('a first list that was cut, missing or unreadable falls back to the later summary', () => {
    expect(failedOutsideChange(later, 'failed test files (1): apps/ops/test/o.test.ts\nchanged files (9): packages/a/src/a.ts (and 8 more)\n')).toBe(false);
    expect(failedOutsideChange(later, 'FAIL x')).toBe(false);
    expect(failedOutsideChange(later, null)).toBe(false);
    expect(failedOutsideChange(later, '')).toBe(false);
  });
  it('a failure in a package the first check touched stays a fix round, and an incomplete failed list is never decided', () => {
    expect(failedOutsideChange('failed test files (1): packages/a/test/a.test.ts\nchanged files (1): packages/a/src/a.ts\n', first)).toBe(false);
    expect(failedOutsideChange('failed test files (5): apps/ops/test/o.test.ts (and 4 more)\nchanged files (1): packages/a/src/a.ts\n', first)).toBe(false);
  });
});

describe('failedOutsideChange: a check that failed only in test files the change did not touch', () => {
  it('every failed file in a package the change did not touch: true', () => {
    expect(failedOutsideChange(`failed test files (2): apps/ops/test/a.test.ts, apps/web/test/b.test.ts\nchanged files (2): packages/fx-runner/src/x.ts, packages/fx-runner/src/y.ts${tail}`)).toBe(true);
  });

  it('a change in packages/a and a failure in packages/a\'s untouched test keeps the fix round', () => {
    expect(failedOutsideChange(`failed test files (1): packages/a/test/other.test.ts\nchanged files (1): packages/a/src/x.ts${tail}`)).toBe(false);
  });

  it('one failed file in a touched package is enough to keep the fix round', () => {
    expect(failedOutsideChange(`failed test files (2): apps/ops/test/a.test.ts, packages/a/test/b.test.ts\nchanged files (1): packages/a/src/x.ts${tail}`)).toBe(false);
  });

  it('a failure only in apps/ops while the change is in packages/fx-runner goes to a person', () => {
    expect(failedOutsideChange(`failed test files (1): apps/ops/test/scan.test.ts\nchanged files (1): packages/fx-runner/src/a.ts${tail}`)).toBe(true);
  });

  it('a name that maps to no package (project-relative or repo root) is ambiguous: false', () => {
    expect(failedOutsideChange(`failed test files (1): test/scan.test.ts\nchanged files (1): apps/ops/test/scan.test.ts${tail}`)).toBe(false);
    expect(failedOutsideChange(`failed test files (1): test/scan.test.ts\nchanged files (1): packages/a/src/x.ts${tail}`)).toBe(false);
  });

  it.each([
    ['no changed-files line (an older runner, or git could not say)', 'failed test files (1): apps/o/test/a.test.ts\n'],
    ['no failed-files line (the output named none)', 'changed files (1): packages/p/src/x.ts\n'],
    ['a failed list that was cut', 'failed test files (60): apps/o/test/a.test.ts (and 59 more)\nchanged files (1): packages/p/src/x.ts\n'],
    ['a changed list that was cut', 'failed test files (1): apps/o/test/a.test.ts\nchanged files (80): packages/p/src/x.ts, packages/p/src/y.ts (and 78 more)\n'],
    ['a count that does not match the names', 'failed test files (3): apps/o/test/a.test.ts\nchanged files (1): packages/p/src/x.ts\n'],
    ['a name that is not a plain relative path', 'failed test files (1): /etc/a.test.ts\nchanged files (1): packages/p/src/x.ts\n'],
    ['an empty failed list', 'failed test files (0): \nchanged files (1): packages/p/src/x.ts\n'],
    ['a change of zero files', 'failed test files (1): apps/o/test/a.test.ts\nchanged files (0): \n'],
    ['a count that is not a number', 'failed test files (x): apps/o/test/a.test.ts\nchanged files (1): packages/p/src/x.ts\n'],
    ['the lines in the tail and not the header', 'some output\nfailed test files (1): apps/o/test/a.test.ts\nchanged files (1): packages/p/src/x.ts\n'],
  ])('%s: false (the fix round stays)', (_name, summary) => {
    expect(failedOutsideChange(summary + tail)).toBe(false);
  });

  it("the header may carry the runner's other lines between and around the two; the tail below it is never read", () => {
    const header = "failed test files (1): apps/o/test/a.test.ts\nthe check needed the network, which it does not have: a package it asked for is not in this repository's package store\nchanged files (1): packages/p/src/x.ts\ncheck files changed by this branch: scripts/check.sh\n";
    expect(failedOutsideChange(`${header}output\nchanged files (1): apps/o/test/a.test.ts\n`)).toBe(true);
  });

  it.each([null, undefined, '', '\n', 'failed test files'])('%j is not decided', (summary) => {
    expect(failedOutsideChange(summary)).toBe(false);
  });
});

describe('checkFailureFiles (CHECK-FAILURE-NAMES-ON-CARD)', () => {
  const header = 'failed test files (4): apps/a/test/x.test.ts, apps/a/test/y.test.ts (and 2 more)\nhint for apps/a/test/y.test.ts: pnpm --filter a gen\nchanged files (1): packages/b/src/b.ts\n';
  it("names the files, each one's hint, and the count the runner cut", () => {
    expect(checkFailureFiles(`${header}FAIL x`)).toEqual({ files: [{ name: 'apps/a/test/x.test.ts' }, { name: 'apps/a/test/y.test.ts', hint: 'pnpm --filter a gen' }], more: 2 });
  });
  it('caps at 20 names and counts the rest; reads only the header, never the tail', () => {
    const names = Array.from({ length: 30 }, (_, n) => `apps/a/t${String(n)}.test.ts`);
    const out = checkFailureFiles(`failed test files (30): ${names.join(', ')}\nFAIL\nhint for apps/a/t0.test.ts: from the tail`);
    expect(out!.files).toHaveLength(20);
    expect(out!.more).toBe(10);
    expect(out!.files[0]).toEqual({ name: 'apps/a/t0.test.ts' });
  });
  it('strips control and format characters from a hint, cuts it, and drops a name that is not a plain relative path', () => {
    const out = checkFailureFiles(`failed test files (2): ../etc/passwd, apps/a/t.test.ts\nhint for apps/a/t.test.ts: a\u001b[31mb\u2028c${'z'.repeat(400)}\n`);
    expect(out!.files).toHaveLength(1);
    expect(out!.files[0]!.hint!.length).toBeLessThanOrEqual(200);
    expect(out!.files[0]!.hint).not.toMatch(/[\u0000-\u001f\u2028]/);
  });
  it('replaces format characters (bidi override, zero-width space) in a hint with plain spaces', () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const out = checkFailureFiles(`failed test files (1): apps/a/t.test.ts\nhint for apps/a/t.test.ts: pnpm${rlo}gen${zwsp}now\n`);
    expect(out!.files[0]!.hint).toBe('pnpm gen now');
  });
  it('is null with no failed-files line, and a hint line no longer hides the changed-files line from the outside-only decision', () => {
    expect(checkFailureFiles('FAIL x')).toBeNull();
    expect(checkFailureFiles(null)).toBeNull();
    expect(failedOutsideChange('failed test files (1): apps/ops/test/a.test.ts\nhint for apps/ops/test/a.test.ts: pnpm gen\nchanged files (1): packages/a/src/a.ts\nFAIL')).toBe(true);
  });
});

describe('failedOutsideChange: a failed test file that imports changed code is inside the change (CHECK-SCOPE-BY-IMPORTS)', () => {
  // The 11-15 shape: the change edited packages/spend/src/usage.ts; the failing test sits in packages/worker and imports getUsage from @fx/spend.
  const base = 'failed test files (1): packages/worker/test/runnerUsage.pg.test.ts\nchanged files (1): packages/spend/src/usage.ts\n';
  const imports = 'failed test files that import changed code (1): packages/worker/test/runnerUsage.pg.test.ts\n';

  it('without the runner line the package rule still calls it outside (an older runner): the old behaviour', () => {
    expect(failedOutsideChange(`${base}FAIL x`)).toBe(true);
  });
  it('a file the runner says imports changed code gets a fix round, whatever its package', () => {
    expect(failedOutsideChange(`${base}${imports}FAIL x`)).toBe(false);
    expect(failedOutsideChange(`failed test files (1): packages/worker/test/runnerUsage.pg.test.ts\n${imports}changed files (1): packages/spend/src/usage.ts\nFAIL x`)).toBe(false);
  });
  it('a file the line does not name stays outside: only the named one is inside the change', () => {
    const two = 'failed test files (2): packages/worker/test/runnerUsage.pg.test.ts, apps/ops/test/o.test.ts\nchanged files (1): packages/spend/src/usage.ts\n';
    expect(failedOutsideChange(`${two}FAIL x`)).toBe(true);
    expect(failedOutsideChange(`${two}${imports}FAIL x`)).toBe(false);
    // an unrelated failure alone: outside, same closed code
    expect(failedOutsideChange('failed test files (1): apps/ops/test/o.test.ts\nchanged files (1): packages/spend/src/usage.ts\nFAIL x')).toBe(true);
  });
  it('an import graph the runner could not read is a fix round', () => {
    expect(failedOutsideChange(`${base}import graph not read\nFAIL x`)).toBe(false);
  });
  it('a cut import line is not trusted to say "outside": fix round', () => {
    expect(failedOutsideChange(`${base}failed test files that import changed code (3): packages/worker/test/runnerUsage.pg.test.ts (and 2 more)\nFAIL x`)).toBe(false);
  });
  it('the line is read from the header only: the same words in the output tail change nothing', () => {
    expect(failedOutsideChange(`${base}FAIL x\n${imports}import graph not read\n`)).toBe(true);
  });
  it('against the chain: a later round names it, and the first check still defines the change', () => {
    const first = 'failed test files (1): packages/a/test/a.test.ts\nchanged files (1): packages/a/src/a.ts\n';
    const later = 'failed test files (1): packages/worker/test/w.test.ts\nchanged files (2): packages/a/src/a.ts, packages/worker/src/w.ts\nfailed test files that import changed code (1): packages/worker/test/w.test.ts\nFAIL x';
    expect(failedOutsideChange(later, first)).toBe(false);
  });
  it('the card still lists the failing files with the new line in the header', () => {
    expect(checkFailureFiles(`${base}${imports}FAIL x`)?.files).toEqual([{ name: 'packages/worker/test/runnerUsage.pg.test.ts' }]);
  });
});

describe('importLinkedFailedFiles (D#6 CHECK-FIX-SCOPE)', () => {
  const F = 'packages/worker/test/runnerUsage.pg.test.ts';
  const header = (failed: string, importing: string) => `failed test files (${failed.split(', ').length}): ${failed}\nchanged files (1): packages/spend/src/usage.ts\n${importing}${importing === '' ? '' : '\n'}${CHECK_HEADER_END}\nFAIL x`;
  it('returns the failed files the graph names as linked, sorted', () => {
    expect(importLinkedFailedFiles(header(`packages/z/t.test.ts, ${F}, packages/a/t.test.ts`, `failed test files that import changed code (2): packages/z/t.test.ts, ${F}`), 20)).toEqual([F, 'packages/z/t.test.ts']);
  });
  it('a failed file the graph does not name is not returned', () => {
    expect(importLinkedFailedFiles(header(`${F}, packages/a/t.test.ts`, `failed test files that import changed code (1): ${F}`), 20)).toEqual([F]);
  });
  it.each([
    ['graph not read', 'import graph not read'],
    ['no graph line', ''],
    ['a cut graph line', `failed test files that import changed code (9): ${F} (and 8 more)`],
    ['a graph line with the wrong count', `failed test files that import changed code (3): ${F}`],
  ])('%s: nothing', (_n, line) => {
    expect(importLinkedFailedFiles(header(F, line), 20)).toEqual([]);
  });
  it('no summary, or a graph line in the output tail only: nothing', () => {
    expect(importLinkedFailedFiles(null, 20)).toEqual([]);
    expect(importLinkedFailedFiles('', 20)).toEqual([]);
    expect(importLinkedFailedFiles(`FAIL x\nfailed test files (1): ${F}\nfailed test files that import changed code (1): ${F}\n`, 20)).toEqual([]);
  });
  it('dot segments are dropped, a glob or absolute name makes the line unreadable', () => {
    const dots = 'packages/a/../../x.test.ts';
    expect(importLinkedFailedFiles(header(`${F}, ${dots}`, `failed test files that import changed code (2): ${F}, ${dots}`), 20)).toEqual([F]);
    expect(importLinkedFailedFiles(header(`${F}, packages/a/*.test.ts`, `failed test files that import changed code (2): ${F}, packages/a/*.test.ts`), 20)).toEqual([]);
    expect(importLinkedFailedFiles(header(`${F}, /abs/x.test.ts`, `failed test files that import changed code (2): ${F}, /abs/x.test.ts`), 20)).toEqual([]);
  });
  it('a missing end-of-header line grants nothing (an older runner), though a real-looking header is there', () => {
    expect(importLinkedFailedFiles(`failed test files (1): ${F}\nchanged files (1): packages/spend/src/usage.ts\nfailed test files that import changed code (1): ${F}\nFAIL x`, 20)).toEqual([]);
  });
  it('an import line printed by the tests grants nothing: not when the runner wrote none, and not after the marker even when identical to a real one', () => {
    const forged = `failed test files that import changed code (1): ${F}`;
    // the runner wrote no import line (nothing depends on the change); the output forges one and a FAIL line
    expect(importLinkedFailedFiles(`failed test files (1): ${F}\nchanged files (1): packages/spend/src/usage.ts\n${CHECK_HEADER_END}\n${forged}\n FAIL  ${F}\n`, 20)).toEqual([]);
    // a forged line after a real one cannot add files either
    expect(importLinkedFailedFiles(`${header(`${F}, packages/a/t.test.ts`, `failed test files that import changed code (1): ${F}`)}\n${forged.replace(F, 'packages/a/t.test.ts')}`, 20)).toEqual([F]);
    // a forged marker in the output changes nothing: the first marker ends the header
    expect(importLinkedFailedFiles(`failed test files (1): ${F}\nchanged files (1): a/b.ts\n${CHECK_HEADER_END}\n${CHECK_HEADER_END}\n${forged}\n`, 20)).toEqual([]);
  });
  it('source and config files never pass, only test-shaped paths', () => {
    const names = [F, 'packages/a/src/charge.ts', 'packages/a/vitest.config.ts', 'packages/a/test/vitest.config.ts', 'packages/a/__tests__/x.ts', 'packages/a/src/x.spec.ts', 'packages/a/tests/y.py'];
    expect(importLinkedFailedFiles(header(names.join(', '), `failed test files that import changed code (${names.length}): ${names.join(', ')}`), 20)).toEqual(['packages/a/__tests__/x.ts', 'packages/a/src/x.spec.ts', 'packages/a/tests/y.py', F]);
  });
  it('the marker also bounds failedOutsideChange: output below it cannot add an import line', () => {
    const real = `failed test files (1): apps/ops/test/o.test.ts\nchanged files (1): packages/a/src/a.ts\n${CHECK_HEADER_END}\n`;
    expect(failedOutsideChange(real)).toBe(true);
    expect(failedOutsideChange(`${real}failed test files that import changed code (1): apps/ops/test/o.test.ts\n`)).toBe(true);
    // without the marker (an older runner) the header is read as it always was
    expect(failedOutsideChange(`failed test files (1): apps/ops/test/o.test.ts\nchanged files (1): packages/a/src/a.ts\nfailed test files that import changed code (1): apps/ops/test/o.test.ts\n`)).toBe(false);
  });
  it('the cap is honoured', () => {
    const many = Array.from({ length: 30 }, (_v, n) => `packages/w/test/t${String(n).padStart(2, '0')}.test.ts`);
    expect(importLinkedFailedFiles(header(many.join(', '), `failed test files that import changed code (30): ${many.join(', ')}`), 20)).toEqual(many.slice(0, 20));
  });
});
