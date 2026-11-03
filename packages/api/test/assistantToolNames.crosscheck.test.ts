import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOL_NAMES, assistantToolDefs } from '../../core/src/assistant/tools.js';
import { ALLOWED_TOOLS, CORRECTION_TOOL_ARGS } from '../../fx-runner/src/assistant/proxy.js';
import { READ_TOOL_ARGS } from '../../fx-runner/src/assistant/readTools.js';

/**
 * D#597 CC-6a-1 (CC6A-NAME-RECONCILE): the runner's tool list and the hosted registry are not the same list, and that is ruled, not accidental. Both
 * lists are read from the real modules; a tool added to either side, or an argument renamed, fails here until the difference is written down.
 */
const SHARED = ['draft_correction', 'get_item', 'get_plan', 'get_run_activity', 'list_corrections'];
const RUNNER_ONLY = ['get_receipts', 'get_run', 'get_run_events'];
const HOSTED_ONLY = ['get_spec', 'get_verdicts'];
/** The one argument-name difference: the runner's correction tools say `work_item_id`, the hosted tools say `item_id`. No rename (ruled 11-03). */
const ARG_DIFFERENCES: Record<string, { runner: string[]; hosted: string[] }> = {
  draft_correction: { runner: ['work_item_id'], hosted: ['item_id'] },
  list_corrections: { runner: ['work_item_id'], hosted: ['item_id'] },
};

const runnerArgs = (name: string): string[] => [...(READ_TOOL_ARGS[name] ?? CORRECTION_TOOL_ARGS[name] ?? [])].sort();
const hostedArgs = (name: string): string[] => {
  const def = assistantToolDefs().find((t) => t.name === name);
  return Object.keys((def?.input_schema as { properties: Record<string, unknown> }).properties).sort();
};

describe('the runner and hosted assistant tool lists (D#597 CC-6a-1, CC6A-NAME-RECONCILE)', () => {
  const runner = [...ALLOWED_TOOLS].sort();
  const hosted = [...ASSISTANT_TOOL_NAMES].sort();

  it('differ only by the written-out sets of runner-only and hosted-only names', () => {
    expect(runner.filter((n) => hosted.includes(n))).toEqual(SHARED);
    expect(runner.filter((n) => !hosted.includes(n))).toEqual(RUNNER_ONLY);
    expect(hosted.filter((n) => !runner.includes(n))).toEqual(HOSTED_ONLY);
  });

  it('agree on every shared tool\'s argument names except the written-out difference', () => {
    for (const name of SHARED) {
      const r = runnerArgs(name);
      const h = hostedArgs(name);
      const diff = { runner: r.filter((a) => !h.includes(a)), hosted: h.filter((a) => !r.includes(a)) };
      expect(diff, name).toEqual(ARG_DIFFERENCES[name] ?? { runner: [], hosted: [] });
    }
  });

  it('gives every runner tool an argument list, so the check above cannot pass on an empty read', () => {
    for (const name of ALLOWED_TOOLS) expect(runnerArgs(name).length, name).toBeGreaterThan(0);
    expect(runnerArgs('draft_correction')).toEqual(['body', 'kind', 'work_item_id']);
    expect(hostedArgs('draft_correction')).toEqual(['body', 'item_id', 'kind']);
  });
});
