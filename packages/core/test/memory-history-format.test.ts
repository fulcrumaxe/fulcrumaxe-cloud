import { describe, expect, it } from 'vitest';
import { formatMemoryHistoryActor, formatMemoryHistoryAction } from '../src/memory/format.js';
import { MEMORY_HISTORY_ACTIONS } from '../src/memory/history.js';

/** D#601 MEM-4b2: the history wording is fixed text per action, never the raw audit text, and never blank, null or "undefined". */
describe('memory history wording', () => {
  it('every action the history can return has its own phrase', () => {
    const labels = MEMORY_HISTORY_ACTIONS.map((a) => formatMemoryHistoryAction(a));
    for (const l of labels) expect(l).toMatch(/^\S.*\S$/);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain('Changed');
  });

  it('an action it does not know, or a non-string, reads "Changed" and echoes nothing', () => {
    for (const v of ['memory.mystery', '', null, undefined, 7, { a: 1 }]) expect(formatMemoryHistoryAction(v)).toBe('Changed');
  });

  it('names the actor in words', () => {
    expect(formatMemoryHistoryActor({ kind: 'person' })).toBe('A member');
    expect(formatMemoryHistoryActor({ kind: 'system', source: 'memory_sweep' })).toBe('Memory sweep');
    expect(formatMemoryHistoryActor({ kind: 'system', source: 'pipeline' })).toBe('The pipeline');
    expect(formatMemoryHistoryActor({ kind: 'unknown' })).toBe('Unknown');
  });
});
