import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERSON_MERGES_REASONS, QUEUED_TO_MERGE_LABEL, QUEUED_TO_MERGE_SUBTITLE, blockingReasons, onlyPersonMerges, removalRetryAllowed, removedByPerson } from '../src/work-items/mergeReadiness.js';
import { classifyStall, type StallFacts } from '../src/work-items/stalled.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const gateFacts = (reasons: string[]): StallFacts => ({
  stage: 'review_passed', halted: false, liveRun: false, pendingRequest: false, waitingAsk: false, now: NOW, lastActivity: new Date(NOW.getTime() - 60_000),
  last: { kind: 'merge_gate', code: 'ready_human_merges', reasons, at: new Date(NOW.getTime() - 60_000) },
});

describe('which gate reasons leave an item ready for a person to merge', () => {
  it('no reasons, or only reasons that mean a person presses merge, is ready', () => {
    expect(onlyPersonMerges([])).toBe(true);
    expect(onlyPersonMerges(['auto_merge_not_allowed'])).toBe(true);
    expect(onlyPersonMerges(['human_merge_only', 'review_round_cap'])).toBe(true);
  });

  it.each([
    'pr_draft', 'ci_not_green', 'public_pr_not_open', 'public_head_unrecorded', 'public_head_not_reviewed', 'stacked_on_open_pr', 'stacked_on_pr_40', 'merge_conflict',
    'verdict_not_pass_code_reviewer', 'missing_run_security_reviewer', 'merge_call_refused', 'a_code_nobody_has_heard_of',
  ])('%s blocks, alone or beside a person-merges reason', (reason) => {
    expect(onlyPersonMerges([reason])).toBe(false);
    expect(onlyPersonMerges(['auto_merge_not_allowed', reason])).toBe(false);
    expect(blockingReasons(['auto_merge_not_allowed', reason])).toEqual([reason]);
  });

  it('the observed state (draft, checks, no auto-merge, no public pull request) is stalled, not ready', () => {
    expect(classifyStall(gateFacts(['pr_draft', 'ci_not_green', 'auto_merge_not_allowed', 'public_pr_not_open']))).toMatchObject({ code: 'gate_not_ready' });
  });

  it('a blocking reason that time does not clear (a review did not pass) also stalls the item when nobody asked the gate again', () => {
    expect(classifyStall(gateFacts(['verdict_not_pass_code_reviewer']))).toMatchObject({ code: 'gate_not_ready' });
  });

  it("the Pipeline app's copy of the list is the same list", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', '..', 'apps', 'workspace', 'apps', 'pipeline', 'pipeline-insight.js'), 'utf8');
    const block = /export const PERSON_MERGES_REASONS = \[([^\]]*)\]/.exec(src);
    expect(block).not.toBeNull();
    const names = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([...PERSON_MERGES_REASONS]);
  });

  it("D#694 B6-3: the label and subtitle are fixed words, and the Pipeline app's banner shows the same ones, pinned", () => {
    expect(QUEUED_TO_MERGE_LABEL).toBe('Queued to merge');
    expect(QUEUED_TO_MERGE_SUBTITLE).toBe("Waiting for GitHub's merge queue to build and merge it");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', '..', '..', 'apps', 'workspace', 'apps', 'pipeline', 'pipeline-insight.js'), 'utf8');
    expect(src).toContain(`export const QUEUED_TO_MERGE_LABEL = "${QUEUED_TO_MERGE_LABEL}";`);
    expect(src).toContain(`export const QUEUED_TO_MERGE_SUBTITLE = "${QUEUED_TO_MERGE_SUBTITLE}";`);
  });

  it('D#694 B6-3: one automatic retry per head, derived from the removals: the first removal by GitHub only', () => {
    expect(removalRetryAllowed([])).toBe(false);
    expect(removalRetryAllowed([{ reasons: ['actor_app'] }])).toBe(true);
    expect(removalRetryAllowed([{ reasons: ['actor_user'] }])).toBe(false);
    expect(removalRetryAllowed([{ reasons: ['actor_you'] }])).toBe(false);
    expect(removedByPerson(['actor_you'])).toBe(true);
    expect(removedByPerson(['actor_user'])).toBe(true);
    expect(removedByPerson(['actor_app'])).toBe(false);
    expect(removedByPerson([])).toBe(false);
    expect(removalRetryAllowed([{ reasons: ['actor_app'] }, { reasons: ['actor_app'] }])).toBe(false);
  });
});
