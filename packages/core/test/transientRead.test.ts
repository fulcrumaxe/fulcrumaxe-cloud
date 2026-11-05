import { describe, expect, it } from 'vitest';
import { TRANSIENT_READ_BUDGET_MS, TRANSIENT_READ_DELAYS_MS, isTransientReadError, retryTransientRead, transientReadError } from '../src/github/transientRead.js';

// A fake read that fails `n` times with `err` and then answers; `reads` is how many times it was asked.
const flaky = (n: number, err: unknown) => {
  const state = { reads: 0 };
  const read = async (): Promise<string> => {
    if (++state.reads <= n) throw err;
    return 'ok';
  };
  return { state, read };
};
const noSleep = async (): Promise<void> => undefined;

describe('retryTransientRead', () => {
  it.each([0, 1, 2])('a read that fails %i time(s) with a blip and then passes answers, after n+1 reads', async (n) => {
    const f = flaky(n, transientReadError('blip'));
    await expect(retryTransientRead(f.read, { sleep: noSleep })).resolves.toBe('ok');
    expect(f.state.reads).toBe(n + 1);
  });

  it('a read that never passes is asked exactly three times and throws the last error unchanged', async () => {
    const err = transientReadError('still down');
    const f = flaky(99, err);
    const waits: number[] = [];
    await expect(retryTransientRead(f.read, { sleep: async (ms) => void waits.push(ms) })).rejects.toBe(err);
    expect(f.state.reads).toBe(3);
    expect(waits).toEqual([...TRANSIENT_READ_DELAYS_MS]);
  });

  it.each([
    ['a plain error (a 4xx, a malformed answer)', new Error('forbidden')],
    ['an error flagged not transient', Object.assign(new Error('x'), { transient: false })],
    ['a refused request of the installation client', Object.assign(new Error('x'), { reason: 'path_refused' })],
    ['a string', 'boom'],
  ])('%s is thrown at once, after one read', async (_why, err) => {
    const f = flaky(99, err);
    await expect(retryTransientRead(f.read, { sleep: noSleep })).rejects.toBe(err);
    expect(f.state.reads).toBe(1);
  });

  it('the installation client\'s transport failure (request_failed) is a blip', () => {
    expect(isTransientReadError(Object.assign(new Error('x'), { reason: 'request_failed' }))).toBe(true);
    expect(isTransientReadError(null)).toBe(false);
  });

  it('no attempt starts after the time budget, so slow timeouts do not stack up', async () => {
    let clock = 0;
    const f = flaky(99, transientReadError('slow'));
    const read = async () => {
      clock += TRANSIENT_READ_BUDGET_MS; // each read took the whole budget
      return f.read();
    };
    await expect(retryTransientRead(read, { sleep: noSleep, now: () => clock })).rejects.toThrow('slow');
    expect(f.state.reads).toBe(1);
  });
});
