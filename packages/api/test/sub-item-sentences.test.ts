import { describe, expect, it } from 'vitest';
import { CHILD_LAUNCH_CODES, CHILD_LAUNCH_SENTENCES, childLaunchSentence } from '@fx/core/src/decisions/childLaunch.js';
import { MESSAGES } from '../src/routes/subItemApprovals.js';

/** D#483 S5-b2c-2: the approve route holds no sentence of its own for a planned PR child; every one is the core map's (the card and the route say the same words). */
describe('the approve route\'s planned PR sentences are the core map\'s', () => {
  const childCodes = CHILD_LAUNCH_CODES.filter((c) => Object.hasOwn(MESSAGES, c));

  it('the route answers every code a person\'s Approve can be refused with', () => {
    for (const code of ['child_build_unsupported', 'child_orphaned', 'parent_closed', 'key_not_in_approved_spec', 'parent_no_envelope', 'parent_envelope_reached', 'child_closed']) {
      expect(childCodes).toContain(code);
    }
  });

  it('each is exactly the map\'s sentence, with the fixed fallback for a title the route has none for', () => {
    for (const code of childCodes) {
      if (code === 'respec_needs_approval') continue; // the route's own wording for the parent's re-approval, not a child sentence
      expect(MESSAGES[code]).toBe(childLaunchSentence(code));
    }
  });

  it('a sentence the route returns that the map does not hold fails: every child sentence maps back to an entry of the map', () => {
    const held = new Set(Object.values(CHILD_LAUNCH_SENTENCES).map((t) => t.replace('<sibling title>', 'another planned PR').replace('<parent title>', 'the item it belongs to')));
    for (const code of childCodes) {
      if (code === 'respec_needs_approval') continue;
      expect(held.has(MESSAGES[code]!)).toBe(true);
    }
  });
});
