import { describe, expect, it } from 'vitest';
import { changedPathsHint, failedOutsideChange } from '../src/work-items/checkFailure.js';

const tail = '\nsome output tail\n';

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

describe('changedPathsHint (SCOPE-BEFORE-CHECK)', () => {
  it('names the paths of the changed-files line in the header, among the runner\'s other header lines', () => {
    expect(changedPathsHint(`failed test files (1): a.test.ts\nchanged files (2): src/a.ts, secrets/key.pem${tail}`)).toEqual(['src/a.ts', 'secrets/key.pem']);
  });

  it('a cut list still names what it shows; the count of the rest is not a name', () => {
    expect(changedPathsHint(`changed files (80): src/a.ts, src/b.ts (and 78 more)${tail}`)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('never reads the output tail: the same line below the header is not a hint', () => {
    expect(changedPathsHint('some output\nchanged files (1): secrets/key.pem\n')).toEqual([]);
  });

  it('a name that is not a plain relative path is dropped', () => {
    expect(changedPathsHint('changed files (2): /etc/passwd, src/a.ts\n')).toEqual(['src/a.ts']);
  });

  it.each([null, undefined, '', 'changed files (x): a.ts\n', 'no header at all'])('%j gives no hint', (summary) => {
    expect(changedPathsHint(summary)).toEqual([]);
  });
});
