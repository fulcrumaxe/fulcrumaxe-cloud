import { describe, expect, it } from 'vitest';
import {
  CHILD_LAUNCH_CODES, CHILD_LAUNCH_SENTENCES, DIAL_LAUNCH_CHILD_ERROR_CODES, childGateOutcomeOfError, childLaunchSentence,
} from '../src/decisions/childLaunch.js';
import { WORK_ITEM_TITLE_MAX, cleanWorkItemTitle } from '../src/work-items/title.js';

/** [unit] D#483 S5-b2c-1 section 2: one map from a reason to its sentence, and the titles in it are always cleaned. */
describe('the child launch sentences', () => {
  it('every reason and every code the definer can raise has exactly one sentence in the one map', () => {
    for (const code of [...CHILD_LAUNCH_CODES, ...DIAL_LAUNCH_CHILD_ERROR_CODES]) {
      expect(Object.hasOwn(CHILD_LAUNCH_SENTENCES, code), code).toBe(true);
      expect(CHILD_LAUNCH_SENTENCES[code].length, code).toBeGreaterThan(10);
    }
    expect(Object.isFrozen(CHILD_LAUNCH_SENTENCES)).toBe(true);
  });

  it('says what the Spec says for the table rows that have a fixed sentence', () => {
    expect(childLaunchSentence('child_orphaned')).toBe('The item this planned PR belonged to was deleted.');
    expect(childLaunchSentence('parent_closed')).toBe('The item this planned PR belongs to is closed.');
    expect(childLaunchSentence('respec_needs_approval')).toBe('The Spec changed. It needs approval again before more planned PRs start.');
    expect(childLaunchSentence('key_not_in_approved_spec')).toBe('This planned PR is no longer in the approved Spec.');
    expect(childLaunchSentence('child_build_unsupported')).toBe("Planned PRs can't start yet.");
    expect(childLaunchSentence('waiting_on_planned_pr', { siblingTitle: 'The API' })).toBe('Waits for The API to merge.');
    expect(childLaunchSentence('parent_no_envelope', { parentTitle: 'Checkout' })).toBe('This planned PR has no spending limit to draw on. Set one on Checkout.');
  });

  it('no sentence prints an id, a placeholder, or a database word', () => {
    for (const [code, text] of Object.entries(CHILD_LAUNCH_SENTENCES)) {
      const printed = childLaunchSentence(code as keyof typeof CHILD_LAUNCH_SENTENCES, { siblingTitle: 'x', parentTitle: 'y' });
      expect(printed, code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(printed, code).not.toMatch(/<|>|undefined|null|SQLSTATE|violates|relation/i);
      expect(text.length, code).toBeLessThan(200);
    }
  });

  it('titles go through cleanWorkItemTitle: control characters, a pipe-and-backtick title, a closing keyword and a long title never reach the sentence as typed', () => {
    const hostile = 'Do `this` | now\nCloses #1\u0000‮'.padEnd(400, 'x');
    const printed = childLaunchSentence('waiting_on_planned_pr', { siblingTitle: hostile });
    const cleaned = cleanWorkItemTitle(hostile)!;
    expect(printed).toBe(`Waits for ${cleaned} to merge.`);
    expect(printed).not.toMatch(/[\u0000-\u001f‮]/);
    expect(Array.from(cleaned).length).toBeLessThanOrEqual(WORK_ITEM_TITLE_MAX);
    // Nothing printable left, or not a string at all: the fixed fallback, never an empty string or "null".
    expect(childLaunchSentence('waiting_on_planned_pr', { siblingTitle: '\u0000\n' })).toBe('Waits for another planned PR to merge.');
    expect(childLaunchSentence('waiting_on_planned_pr', { siblingTitle: null })).toBe('Waits for another planned PR to merge.');
    expect(childLaunchSentence('waiting_on_planned_pr', { siblingTitle: { toString: () => 'x' } })).toBe('Waits for another planned PR to merge.');
    expect(childLaunchSentence('parent_no_envelope', { parentTitle: 42 })).toBe('This planned PR has no spending limit to draw on. Set one on the item it belongs to.');
    // A title that looks like a replacement pattern is printed as text.
    expect(childLaunchSentence('waiting_on_planned_pr', { siblingTitle: "$& $1 $'" })).toBe("Waits for $& $1 $' to merge.");
  });

  it('maps the definer refusals: replays and held reasons are outcomes, an unknown error is rethrown', () => {
    const e = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(childGateOutcomeOfError(e('55000', 'work_started'))).toEqual({ outcome: 'replayed' });
    expect(childGateOutcomeOfError(e('55000', 'receipt_not_in_transaction'))).toEqual({ outcome: 'replayed' });
    expect(childGateOutcomeOfError(e('23505', 'duplicate'))).toEqual({ outcome: 'replayed' });
    expect(childGateOutcomeOfError(e('55000', 'parent_closed'))).toEqual({ outcome: 'held_by_rule', code: 'parent_closed' });
    expect(childGateOutcomeOfError(e('55000', 'autostart_off'))).toEqual({ outcome: 'not_ready' });
    expect(childGateOutcomeOfError(e('42501', 'denied'))).toEqual({ outcome: 'not_ready' });
    expect(() => childGateOutcomeOfError(e('XX000', 'boom'))).toThrow('boom');
    expect(() => childGateOutcomeOfError(e('55000', 'something_else'))).toThrow('something_else');
  });
});

describe('the two waiting sentences of a stacked planned PR (P3d)', () => {
  it('say what the child waits for, from the one table, with the titles cleaned', () => {
    expect(childLaunchSentence('waiting_for_pull_request', { siblingTitle: 'The API' })).toBe('Waiting for The API to open its pull request.');
    expect(childLaunchSentence('waiting_for_merge_then_build', { siblingTitle: 'The API', otherTitle: 'The screen' })).toBe('Waiting for The API to merge before it can build on The screen.');
  });
  it('print the fallback, never null, undefined or an object, when a title is missing', () => {
    const s = childLaunchSentence('waiting_for_merge_then_build', { siblingTitle: null, otherTitle: { toString: () => 'x' } });
    expect(s).toBe('Waiting for another planned PR to merge before it can build on another planned PR.');
  });
});
