import { describe, expect, it } from 'vitest';
import { isCorrectionComment, isSpecDiscussion } from '../src/plan/specTables.js';

/**
 * CWE-1333: the plan reader runs both shape rules on bodies written by anyone who can open a Discussion, up to 60,000
 * characters each. A line-start prefix that can cross a newline made the status rule quadratic on bodies made only of
 * newlines or dash/newline pairs. Each rule must stay linear on those worst cases.
 */
const N = 60_000;
const BOUND_MS = 50; // generous: a linear scan takes well under 1 ms; the quadratic form took seconds
const repeat = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);

const inputs: Array<[string, string]> = [
  ['only newlines', '\n'.repeat(N)],
  ['"-\\n" repeated', repeat('-\n')],
  ['"> \\n" repeated', repeat('> \n')],
  ['"\\r\\n" repeated', repeat('\r\n')],
  ['"##\\n" repeated', repeat('##\n')],
  ['"## \\n" repeated', repeat('## \n')],
  ['"STATUS:\\n" repeated', repeat('STATUS:\n')],
  ['"> **_\\n" repeated', repeat('> **_\n')],
  ['"## Correction \\n" repeated', repeat('## Correction \n')],
  ['spaces then a newline run', ' '.repeat(N / 2) + '\n'.repeat(N / 2)],
];

describe.each([
  ['isSpecDiscussion', isSpecDiscussion],
  ['isCorrectionComment', isCorrectionComment],
] as const)('%s is linear on pathological 60,000-character bodies', (_name, rule) => {
  for (const [label, input] of inputs) {
    it(`${label} finishes in under ${BOUND_MS} ms`, () => {
      expect(input.length).toBe(N);
      const t0 = performance.now();
      rule(input);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(BOUND_MS);
    });
  }
});
