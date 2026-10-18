import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY_WAITING_CHECKED, statusSentence, type StatusSentenceInput } from '../../src/setup-requests/copy.js';

/**
 * D#598 P8b-2 (C3): nothing may promise that an item resumes by itself for a request that no check is looking at. The one approved promise is
 * the sentence for a request WITH a check while checks can run (copy.ts); every description, comment and doc that speaks about resuming must
 * either not promise it or say it is not so. Two halves: a scan of the words we publish, and every state the status line can be in.
 */
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string): string => readFileSync(here(relative), 'utf8');

/** A sentence that says something resumes/continues/restarts by itself, automatically or on its own, and is not a denial. */
const PROMISE = /\b(resum|continu|restart|go(es)? on)\w*\b[^.]{0,60}\b(by itself|by themselves|automatically|on its own|on their own)\b|\bautomatic(ally)?[ -](resume|restart|continu)/i;
const DENIAL = /\b(nothing|never|not|no|cannot|can't|without)\b/i;
const promises = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n\s*\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => PROMISE.test(s) && !DENIAL.test(s));

describe('no promise of an automatic resume where no check looks (C3)', () => {
  it('the API descriptions, the route comments, the core comments and the docs promise none', () => {
    const openapi = JSON.parse(read('../../../api/openapi.json')) as { paths: Record<string, Record<string, { summary?: string; description?: string }>> };
    const apiText = Object.entries(openapi.paths)
      .filter(([path]) => path.startsWith('/api/v1/setup-requests'))
      .flatMap(([, ops]) => Object.values(ops).flatMap((op) => [op.summary ?? '', op.description ?? '']))
      .join('\n\n');
    expect(apiText.length).toBeGreaterThan(200);
    const docs = read('../../../../docs/packages/core.md');
    const docsSection = docs.slice(docs.indexOf('`setup-requests/` (D#598 P8a)'), docs.indexOf('## Security notes'));
    expect(docsSection).toContain('The interval is a normal-case figure, not a guarantee');
    const files = ['store.ts', 'markDone.ts', 'checks.ts', 'kinds.ts'].map((f) => read(`../../src/setup-requests/${f}`));
    const routeFile = read('../../../api/src/routes/setupRequests.ts');
    for (const [where, text] of Object.entries({ apiText, docsSection, routeFile, store: files[0]!, markDone: files[1]!, checks: files[2]!, kinds: files[3]! })) {
      expect({ where, promises: promises(text) }).toEqual({ where, promises: [] });
    }
  });

  it('the scan itself catches a promise and lets a denial through', () => {
    expect(promises('Once it is set the item resumes automatically.')).toHaveLength(1);
    expect(promises('The item continues by itself once it is done.')).toHaveLength(1);
    expect(promises('Nothing resumes by itself: press Mark done.')).toEqual([]);
    expect(promises('The item is restarted at once when a person marks it done.')).toEqual([]);
  });

  it('the only words that promise it are the approved sentence, and the status line says them only for a request with a check that can run', () => {
    expect(PROMISE.test(COPY_WAITING_CHECKED)).toBe(true);
    const states: Array<StatusSentenceInput['state']> = ['open', 'done', 'withdrawn'];
    const checkKinds: Array<StatusSentenceInput['checkKind']> = [null, 'env_var_present'];
    const reasons = [null, 'env_var_missing', 'env_var_wrong_target', 'check_unavailable'];
    const resolutions: Array<NonNullable<StatusSentenceInput['resolution']> | null> = [null, 'marked_done', 'check_passed', 'withdrawn'];
    const now = Date.parse('2026-10-18T10:00:00Z');
    let promising = 0;
    for (const state of states) for (const checkKind of checkKinds) for (const checkReason of reasons) for (const resolution of resolutions) for (const checksAvailable of [false, true]) for (const repaused of [false, true]) {
      const line = statusSentence(
        { state, checkKind, checkReason, resolution, resolvedAt: state === 'open' ? null : new Date(now - 1000), checkRanAt: null, repausedAt: repaused ? new Date(now) : null, target: 'cloud-staging', envName: 'STRIPE_KEY', targetEnvironment: 'production' },
        { checksAvailable, now },
      );
      if (line !== null && PROMISE.test(line)) {
        promising += 1;
        expect({ state, checkKind, checksAvailable, checkReason, repaused }).toMatchObject({ state: 'open', checkKind: 'env_var_present', checksAvailable: true });
        expect(checkReason).not.toBe('check_unavailable');
        // A request put back by its check reads sentence 4 instead (a reopen always leaves a reason code).
        if (repaused) expect(checkReason).toBeNull();
      }
    }
    expect(promising).toBeGreaterThan(0);
  });
});
