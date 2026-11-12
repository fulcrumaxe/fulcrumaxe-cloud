import { describe, expect, it } from 'vitest';
import { checkFailureFiles, failedOutsideChange } from '../src/work-items/checkFailure.js';

const tail = '\nsome output tail\n';

describe('failedOutsideChange against the chain first check', () => {
  const first = 'failed test files (2): packages/a/test/a.test.ts, apps/ops/test/o.test.ts\nchanged files (1): packages/a/src/a.ts\nFAIL x';
  const later = 'failed test files (1): apps/ops/test/o.test.ts\nchanged files (2): apps/ops/src/o.ts, packages/a/src/a.ts\nFAIL x';
  it('a package only a later round edited is not part of the change', () => {
    expect(failedOutsideChange(later)).toBe(false);
    expect(failedOutsideChange(later, first)).toBe(true);
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
