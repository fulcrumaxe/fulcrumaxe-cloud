import { describe, expect, it } from 'vitest';
import { PlanFileShapeError, parseRoadmapFile } from '../src/plan/roadmapFile.js';
import { PlanWriteError, applyTaskUpdates } from '../src/plan/roadmapWriter.js';

/** D#598 P5a: the pure roadmap writer. Edits status, prs and open_prs in place and leaves every other byte alone. */

// A file laid out the way the real roadmap is: two-space indent, one array item per line, unicode kept as is, trailing newline.
const doc = () => ({
  version: 3,
  milestones: {
    m1: { definition: 'First milestone. More text.', tasks: ['D#1:A', 'D#1:B', 'D#2'] },
    m2: { definition: 'Second — with “quotes” and ünïcode.', tasks: ['D#3:C'] },
  },
  task_status: {
    'D#1:A': { milestone: 'm1', status: 'not_started', planned_prs: 2, prs: [], evidence: {}, note: 'first — “row”' },
    'D#1:B': { milestone: 'm1', status: 'in_progress', planned_prs: 1, prs: [11, 12], open_prs: [13], note: 'ünï' },
    'D#2': { milestone: 'm1', planned_prs: 1, prs: [] },
    'D#3:C': { milestone: 'm2', status: 'done', planned_prs: 1, prs: [20] },
    'D#9:SPLIT': { milestone: 'm2', status: 'split', planned_prs: 0, prs: [], split_into: ['D#3:C'] },
    'D#0:HISTORY': { milestone: 'old', status: 'done', planned_prs: 1, prs: [1] },
  },
  trailer: { keep: ['a', 'b'], deep: { x: 1 } },
});
const text = (d: unknown = doc()) => `${JSON.stringify(d, null, 2)}\n`;

/** The text of one task_status row, by key. */
function rowText(t: string, key: string): string {
  const start = t.indexOf(`\n    ${JSON.stringify(key)}: {`);
  const end = t.indexOf('\n    }', start);
  return t.slice(start, end + 6);
}

describe('applyTaskUpdates: the three fields', () => {
  it('sets status, prs and open_prs on a row and nothing else in the document changes', () => {
    const before = text();
    const after = applyTaskUpdates(before, [{ key: 'D#1:B', status: 'done', prs: [14, 11, 12], openPrs: [] }]);
    const task = parseRoadmapFile(after).tasks.find((t) => t.key === 'D#1:B')!;
    expect(task.fileStatus).toBe('done');
    expect(task.filePrs).toEqual([11, 12, 14]);
    expect(task.fileOpenPrs).toEqual([]);
    const expected = doc();
    Object.assign(expected.task_status['D#1:B'], { status: 'done', prs: [11, 12, 14], open_prs: [] });
    expect(JSON.parse(after)).toEqual(expected);
  });

  it('leaves every other row, and the text outside the rows, byte-identical', () => {
    const before = text();
    const after = applyTaskUpdates(before, [{ key: 'D#1:B', status: 'done', prs: [11, 12, 13], openPrs: [] }]);
    for (const k of ['D#1:A', 'D#2', 'D#3:C', 'D#9:SPLIT', 'D#0:HISTORY']) expect(rowText(after, k)).toBe(rowText(before, k));
    const cut = (t: string) => t.replace(rowText(t, 'D#1:B'), '');
    expect(cut(after)).toBe(cut(before));
    expect(after.endsWith('}\n')).toBe(true);
  });

  it('writes the changed row in the file\'s own layout: one array item per line, same indent', () => {
    const after = applyTaskUpdates(text(), [{ key: 'D#1:A', status: 'in_review', prs: [30], openPrs: [31, 32] }]);
    expect(rowText(after, 'D#1:A')).toBe(
      [
        '',
        '    "D#1:A": {',
        '      "milestone": "m1",',
        '      "status": "in_review",',
        '      "planned_prs": 2,',
        '      "prs": [',
        '        30',
        '      ],',
        '      "evidence": {},',
        '      "note": "first — “row”",',
        '      "open_prs": [',
        '        31,',
        '        32',
        '      ]',
        '    }',
      ].join('\n'),
    );
  });

  it('adds a missing status or open_prs member at the end of the row, and a missing empty open_prs adds nothing', () => {
    const after = applyTaskUpdates(text(), [{ key: 'D#2', status: 'open', openPrs: [40] }, { key: 'D#1:A', openPrs: [] }]);
    expect(parseRoadmapFile(after).tasks.find((t) => t.key === 'D#2')).toMatchObject({ fileStatus: 'open', fileOpenPrs: [40] });
    expect(rowText(after, 'D#1:A')).toBe(rowText(text(), 'D#1:A'));
  });

  it('stores prs sorted ascending without repeats', () => {
    const after = applyTaskUpdates(text(), [{ key: 'D#2', prs: [9, 3, 9, 5] }]);
    expect(parseRoadmapFile(after).tasks.find((t) => t.key === 'D#2')!.filePrs).toEqual([3, 5, 9]);
  });

  it('updates several rows in one call', () => {
    const after = applyTaskUpdates(text(), [
      { key: 'D#1:A', status: 'done', prs: [50] },
      { key: 'D#2', status: 'done', prs: [51] },
      { key: 'D#3:C', prs: [20, 52] },
    ]);
    const tasks = parseRoadmapFile(after).tasks;
    expect(tasks.map((t) => [t.key, t.fileStatus, t.filePrs])).toEqual([
      ['D#1:A', 'done', [50]],
      ['D#1:B', 'in_progress', [11, 12]],
      ['D#2', 'done', [51]],
      ['D#3:C', 'done', [20, 52]],
    ]);
  });

  it('three merges in a row, applied one after another, land in one file with all three updates', () => {
    let t = text();
    t = applyTaskUpdates(t, [{ key: 'D#1:A', prs: [60] }]);
    t = applyTaskUpdates(t, [{ key: 'D#1:A', prs: [60, 61] }]);
    t = applyTaskUpdates(t, [{ key: 'D#1:A', prs: [60, 61, 62], status: 'done' }]);
    expect(parseRoadmapFile(t).tasks[0]).toMatchObject({ key: 'D#1:A', filePrs: [60, 61, 62], fileStatus: 'done' });
    expect(t).toBe(applyTaskUpdates(text(), [{ key: 'D#1:A', prs: [60, 61, 62], status: 'done' }]));
  });
});

describe('applyTaskUpdates: idempotence and no-ops', () => {
  it('returns the same text for an update that changes nothing, even when the row\'s layout is unusual', () => {
    const odd = '{"milestones":{"m":{"tasks":["k"]}},"task_status":{"k":{"milestone":"m","planned_prs":1,"prs":[1,2],"status":"done"}}}';
    expect(applyTaskUpdates(odd, [{ key: 'k', status: 'done', prs: [1, 2] }])).toBe(odd);
    expect(applyTaskUpdates(text(), [{ key: 'D#3:C', status: 'done', prs: [20] }])).toBe(text());
  });
  it('returns the input for an empty update list', () => {
    expect(applyTaskUpdates(text(), [])).toBe(text());
  });
  it('applying the same update twice gives the same text as once', () => {
    const u = [{ key: 'D#1:B', status: 'done', prs: [11, 12, 13], openPrs: [] }];
    const once = applyTaskUpdates(text(), u);
    expect(applyTaskUpdates(once, u)).toBe(once);
  });
});

describe('applyTaskUpdates: other layouts', () => {
  it('keeps CRLF line endings', () => {
    const crlf = text().replace(/\n/g, '\r\n');
    const after = applyTaskUpdates(crlf, [{ key: 'D#1:A', prs: [7] }]);
    expect(after).not.toMatch(/[^\r]\n/);
    expect(parseRoadmapFile(after).tasks[0]!.filePrs).toEqual([7]);
  });
  it('keeps a four-space layout', () => {
    const wide = `${JSON.stringify(doc(), null, 4)}\n`;
    const after = applyTaskUpdates(wide, [{ key: 'D#1:A', prs: [7, 8] }]);
    expect(after).toContain('"prs": [\n                7,\n                8\n            ]');
    expect(parseRoadmapFile(after).tasks[0]!.filePrs).toEqual([7, 8]);
  });
  it('edits a row written on one line, and a file with no trailing newline', () => {
    const one = '{"milestones":{"m":{"tasks":["k","j"]}},"task_status":{"k":{"milestone":"m","planned_prs":1,"prs":[]},"j":{"milestone":"m","planned_prs":1,"prs":[]}}}';
    const after = applyTaskUpdates(one, [{ key: 'k', status: 'done', prs: [4, 5], openPrs: [6] }]);
    expect(after).toBe('{"milestones":{"m":{"tasks":["k","j"]}},"task_status":{"k":{"milestone":"m","planned_prs":1,"prs":[4, 5], "status": "done", "open_prs": [6]},"j":{"milestone":"m","planned_prs":1,"prs":[]}}}');
    expect(parseRoadmapFile(after).tasks[0]).toMatchObject({ filePrs: [4, 5], fileStatus: 'done', fileOpenPrs: [6] });
  });
  it('does not confuse a task key that appears as text inside another row or as a nested key', () => {
    const d = doc();
    (d.task_status['D#1:A'] as Record<string, unknown>).note = 'see "D#2": {"status": "x"} and "prs": [99]';
    (d.task_status['D#1:A'] as Record<string, unknown>).evidence = { 'D#2': { status: 'nested', prs: [98] } };
    const after = applyTaskUpdates(text(d), [{ key: 'D#2', status: 'open', prs: [5] }]);
    const parsed = JSON.parse(after) as ReturnType<typeof doc>;
    expect(parsed.task_status['D#1:A']).toEqual(d.task_status['D#1:A']);
    expect(parsed.task_status['D#2']).toMatchObject({ status: 'open', prs: [5] });
  });
});

describe('applyTaskUpdates: refusals', () => {
  const refused = (updates: Parameters<typeof applyTaskUpdates>[1], reason: PlanWriteError['reason'], t = text()) => {
    let err: unknown;
    try {
      applyTaskUpdates(t, updates);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanWriteError);
    expect((err as PlanWriteError).reason).toBe(reason);
  };

  it('refuses a key no milestone counts: absent, a split parent, and a history row', () => {
    refused([{ key: 'D#404' }], 'unknown_task');
    refused([{ key: 'D#9:SPLIT', status: 'done' }], 'unknown_task');
    refused([{ key: 'D#0:HISTORY', status: 'open' }], 'unknown_task');
  });
  it('refuses the same key twice', () => {
    refused([{ key: 'D#2', prs: [1] }, { key: 'D#2', prs: [2] }], 'duplicate_update');
  });
  it('refuses a status that is not a short snake_case word', () => {
    for (const status of ['', 'Done', 'done now', 'a'.repeat(41), '1x', 'done"', 'done\n']) refused([{ key: 'D#2', status }], 'bad_update');
  });
  it('refuses pull request numbers that are not whole numbers of 1 or more', () => {
    for (const bad of [[0], [-1], [1.5], [Number.NaN], ['3' as unknown as number]]) {
      refused([{ key: 'D#2', prs: bad }], 'bad_update');
      refused([{ key: 'D#2', openPrs: bad }], 'bad_update');
    }
  });
  it('refuses a duplicated member in a row, since either value could be the one the parser reads', () => {
    const dup = '{"milestones":{"m":{"tasks":["k"]}},"task_status":{"k":{"milestone":"m","planned_prs":1,"prs":[],"prs":[2]}}}';
    refused([{ key: 'k', prs: [3] }], 'duplicate_member', dup);
  });
  it('refuses an input that is not a valid plan file, with the parser\'s own error', () => {
    expect(() => applyTaskUpdates('{"milestones":{}}', [{ key: 'k' }])).toThrow(PlanFileShapeError);
    expect(() => applyTaskUpdates('not json', [{ key: 'k' }])).toThrow(PlanFileShapeError);
  });
  it('names only the task key in an error, never file content', () => {
    const d = doc();
    (d.task_status['D#2'] as Record<string, unknown>).note = 'SECRET-NOTE-TEXT';
    let err: Error | undefined;
    try {
      applyTaskUpdates(text(d), [{ key: 'D#404' }]);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toContain('D#404');
    expect(err!.message).not.toContain('SECRET-NOTE-TEXT');
  });
});

describe('applyTaskUpdates: round trip on a large generated file', () => {
  it('every parsed task equals the input except the updated fields, for 400 rows and 60 updates', () => {
    const keys = Array.from({ length: 400 }, (_, i) => `D#${i + 1}:T${i}`);
    const status: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      status[k] = i % 3 === 0 ? { milestone: 'm', planned_prs: 1, prs: [] } : { milestone: 'm', status: 'open', planned_prs: 2, prs: [i + 1], open_prs: i % 2 ? [i + 1000] : undefined, note: `n${i} ü` };
    });
    const before = `${JSON.stringify({ milestones: { m: { tasks: keys } }, task_status: status }, null, 2)}\n`;
    const updates = keys.filter((_, i) => i % 7 === 0).slice(0, 60).map((key, n) => ({ key, status: 'done', prs: [n + 1, n + 500], openPrs: [] as number[] }));
    const after = applyTaskUpdates(before, updates);
    const was = parseRoadmapFile(before).tasks;
    const now = parseRoadmapFile(after).tasks;
    const touched = new Map(updates.map((u) => [u.key, u]));
    expect(now.length).toBe(was.length);
    now.forEach((t, i) => {
      const u = touched.get(t.key);
      expect(t).toEqual(u ? { ...was[i], fileStatus: 'done', filePrs: u.prs, fileOpenPrs: [] } : was[i]);
    });
    for (const k of keys.filter((k) => !touched.has(k))) expect(rowText(after, k)).toBe(rowText(before, k));
  });
});
