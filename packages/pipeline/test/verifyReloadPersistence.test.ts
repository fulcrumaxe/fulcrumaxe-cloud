import { describe, expect, it } from 'vitest';
import type { Journey } from '@fx/core/src/verify/journeys.js';
import { outcomeFromAnswer } from '../src/verify/rules.js';

// D#749 VERIFY-RELOAD-ONLY-FOR-PERSISTED: only a persisted journey needs reload evidence.
const step = (over: Record<string, unknown> = {}) => ({ did: 'did a thing', dom_fact: 'the page showed it', ...over });
const answered = (id: string, over: Record<string, unknown> = {}) => ({ id, result: 'pass', steps: [step()], console_errors: 0, undo_checked: true, reloaded: true, ...over });
const noReload = (id: string) => answered(id, { reloaded: false });

const view: Journey = { id: 'c1', source: 'criterion', text: 'Picking a role filters the list to that role', persistence: 'view_only' };
const saved: Journey = { id: 'c2', source: 'criterion', text: 'Saving the nickname keeps it', persistence: 'persisted' };

describe('reload evidence only for persisted journeys', () => {
  it('a view-only journey with steps, a page fact and undo but no reload passes, and the attempt is verified', () => {
    expect(outcomeFromAnswer([view], { journeys: [noReload('c1')] }).input.status).toBe('verified');
  });

  it('the same journey marked persisted, with no reload, stays unproven (hollow_pass)', () => {
    const out = outcomeFromAnswer([{ ...view, persistence: 'persisted' }], { journeys: [noReload('c1')] });
    expect(out.input).toMatchObject({ status: 'unverified', reason: 'hollow_pass' });
  });

  it('a missing or unreadable classification behaves as persisted', () => {
    for (const persistence of [undefined, 'sometimes', 7, null]) {
      const j = { id: 'c1', source: 'criterion', text: 'x', persistence } as unknown as Journey;
      expect(outcomeFromAnswer([j], { journeys: [noReload('c1')] }).input).toMatchObject({ status: 'unverified', reason: 'hollow_pass' });
    }
  });

  it('a view-only journey still needs undo, a page fact and a stated action', () => {
    for (const over of [{ undo_checked: false }, { steps: [] }, { steps: [step({ dom_fact: '' })] }]) {
      expect(outcomeFromAnswer([view], { journeys: [answered('c1', { reloaded: false, ...over })] }).input).toMatchObject({ status: 'unverified', reason: 'hollow_pass' });
    }
  });

  it('a persisted journey beside a view-only one still needs its own reload', () => {
    const out = outcomeFromAnswer([view, saved], { journeys: [noReload('c1'), noReload('c2')] });
    expect(out.input).toMatchObject({ status: 'unverified', reason: 'hollow_pass' });
    if (out.input.status !== 'unverified' || out.input.result == null) throw new Error('unreachable');
    expect(out.input.result.map((r) => `${r.id}:${r.result}`)).toEqual(['c1:pass', 'c2:unverified']);
  });

  it('a row whose journeys all passed with evidence is not hollow', () => {
    expect(outcomeFromAnswer([view, saved], { journeys: [noReload('c1'), answered('c2')] }).input.status).toBe('verified');
  });
});
