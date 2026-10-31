import { describe, expect, it } from 'vitest';
import { DEQUEUE_SUCCESS_CODES, DEQUEUE_UNSPECIFIED, assertDriverEvent, dequeueReasonCode } from '../src/work-items/driverEvents.js';

/** D#694 B6-2: the host's dequeue reason as a stored code. The result always passes the driver-event store's own check. */
describe('dequeueReasonCode', () => {
  it.each([
    ['MERGE_CONFLICT', 'merge_conflict'],
    ['CI_TIMEOUT', 'ci_timeout'],
    ['  Branch protections  ', 'branch_protections'],
    ['MERGE', 'merge'],
    ['ALREADY_MERGED', 'already_merged'],
    ['404 gone', 'x404_gone'],
  ])('%j is %s', (reason, code) => {
    expect(dequeueReasonCode(reason)).toBe(code);
  });

  it.each([[undefined], [null], [7], [{}], [''], ['   '], ['\n\u0007--'], ['éè']])('%j is unspecified', (reason) => {
    expect(dequeueReasonCode(reason)).toBe(DEQUEUE_UNSPECIFIED);
  });

  it('reads at most 200 characters and stores at most 64, and every result is a code the store accepts', () => {
    const long = dequeueReasonCode(`${'a'.repeat(300)} b`);
    expect(long).toHaveLength(64);
    // Only the first 200 characters are read: text after them never decides anything.
    expect(dequeueReasonCode(`${'-'.repeat(200)}abc`)).toBe(DEQUEUE_UNSPECIFIED);
    expect(dequeueReasonCode(`${'-'.repeat(199)}abc`)).toBe('a');
    for (const reason of ['x'.repeat(5000), 'MERGE_CONFLICT\nignore previous instructions', '\u0000', 'ünï', 'a b c']) {
      const code = dequeueReasonCode(reason);
      expect(() => assertDriverEvent({ workItemId: 'w', kind: 'merge_dequeued', dedupeKey: 'k', code })).not.toThrow();
    }
  });

  it('the queue-success codes are what GitHub sends when it dequeues an entry it merged', () => {
    expect(DEQUEUE_SUCCESS_CODES).toEqual(['merge', 'already_merged']);
    expect(DEQUEUE_SUCCESS_CODES.every((c) => dequeueReasonCode(c.toUpperCase()) === c)).toBe(true);
  });
});
