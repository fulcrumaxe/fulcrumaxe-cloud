import { describe, expect, it } from 'vitest';
import { claudePricing } from '@fx/spend';
import { assertLocalRunnerAllowed } from '@fx/runtime/src/local/guard.js';
import { LocalRunnerRefused } from '@fx/runtime/src/types.js';
import { buildTableFromScores, replayTask, type EvalTask } from '../eval/bootstrap.js';
import type { AgentRuntime, NormalizedEvent, StartOptions } from '@fx/runtime/src/types.js';

describe('eval:bootstrap guard (reuses H04\'s local-runner guard)', () => {
  it('refuses without FX_RUNTIME=local -- zero model tokens, the run never starts', () => {
    expect(() => assertLocalRunnerAllowed({})).toThrow(LocalRunnerRefused);
  });

  it('refuses even with FX_RUNTIME=local when a VERCEL* variable is set', () => {
    expect(() => assertLocalRunnerAllowed({ FX_RUNTIME: 'local', VERCEL: '1' })).toThrow(LocalRunnerRefused);
  });

  it('allows FX_RUNTIME=local with no VERCEL* variable set', () => {
    expect(() => assertLocalRunnerAllowed({ FX_RUNTIME: 'local' })).not.toThrow();
  });
});

const TASK: EvalTask = {
  id: 't1',
  role: 'executor',
  size: 'Small',
  prompt: 'p',
  roleCard: 'c',
  capUsd: 1,
  expectedVerdict: 'done',
};

/** A fake runtime that never calls a real model -- it synchronously
 * replays a canned result event, so replayTask's own scoring logic is
 * exercised with zero model tokens. */
function fakeRuntime(verdict: string, usage: { inputTokens: number; outputTokens: number }): AgentRuntime {
  return {
    async start(opts: StartOptions) {
      const event: NormalizedEvent = {
        runId: opts.runId,
        role: opts.role,
        seq: 0,
        type: 'result',
        ts: new Date().toISOString(),
        usage,
        agentOutput: { verdict },
      };
      opts.onEvent(event);
      return { handle: { runId: opts.runId } };
    },
    async stop() {},
    async resume(handle) {
      return { handle };
    },
  };
}

describe('replayTask (fake runtime, zero model tokens)', () => {
  it('scores a matching verdict as success and prices the usage', async () => {
    const result = await replayTask(fakeRuntime('done', { inputTokens: 1_000_000, outputTokens: 0 }), TASK, 'haiku-4.5');
    expect(result.success).toBe(true);
    expect(result.usd).toBeCloseTo(claudePricing()['haiku-4.5'].inputUsdPerMTok); // 1M input tokens at haiku-4.5's input rate
  });

  it('scores a mismatched verdict as failure', async () => {
    const result = await replayTask(fakeRuntime('fail', { inputTokens: 0, outputTokens: 0 }), TASK, 'haiku-4.5');
    expect(result.success).toBe(false);
  });
});

describe('buildTableFromScores (pure, no I/O)', () => {
  it('picks the cheapest model that succeeded on every task for a (role, size) pair', () => {
    const rows = buildTableFromScores([
      { task: TASK, model: 'haiku-4.5', result: { success: true, usd: 0.1 } },
      { task: TASK, model: 'sonnet-5', result: { success: true, usd: 0.5 } },
    ]).rows;
    expect(rows).toEqual([
      { role: 'executor', size: 'Small', model: 'haiku-4.5', rationale: expect.stringContaining('cheapest model') },
    ]);
  });

  it('skips a model that did not succeed on every task', () => {
    const rows = buildTableFromScores([
      { task: TASK, model: 'haiku-4.5', result: { success: false, usd: 0.1 } },
      { task: TASK, model: 'sonnet-5', result: { success: true, usd: 0.5 } },
    ]).rows;
    expect(rows).toEqual([{ role: 'executor', size: 'Small', model: 'sonnet-5', rationale: expect.any(String) }]);
  });

  it('refuses to write a floor-violating row for a floored role (security fix round, CWE-693)', () => {
    // On 3945419, buildTableFromScores never checked a floor at all -- this
    // would have picked Haiku (cheapest passing model) for security-reviewer
    // and written it straight into default-table/v1.json.
    const flooredTask: EvalTask = { ...TASK, role: 'security-reviewer' };
    expect(() =>
      buildTableFromScores([
        { task: flooredTask, model: 'haiku-4.5', result: { success: true, usd: 0.1 } },
        { task: flooredTask, model: 'sonnet-5', result: { success: true, usd: 0.5 } },
      ]),
    ).toThrow(/violates floor/);
  });
});
