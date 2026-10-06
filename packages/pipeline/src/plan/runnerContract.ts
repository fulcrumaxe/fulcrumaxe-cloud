import type { PanelRunner, PanelSeatRequest } from "./panel.js";

/**
 * The contract test for a `PanelRunner` (C41 section 4, H14c-PANEL-1).
 *
 * Deliberately NOT exported from `plan/index.ts` or the package entry: it is
 * a test helper. It is reachable as `@fx/pipeline/plan/runnerContract`, and H15c runs
 * it against the fixture runner; H14c must run it against the real one.
 *
 * It returns the list of violations (empty = the runner honours the
 * contract), so it has no test-framework dependency: a test asserts
 * `toEqual([])`.
 *
 * What it checks, with one fresh key per group:
 *   - two SEQUENTIAL calls with one key return one `agentRunId`;
 *   - FIVE CONCURRENT calls with one key return one `agentRunId`;
 *   - a DIFFERENT key returns a different `agentRunId`;
 *   - `startedRuns` (required) shows the runner started exactly one run for
 *     the sequential group, one for the concurrent group and one for the
 *     other key (for the real runner: one `agent_runs` row and one sandbox
 *     start each);
 *   - a signal that is already aborted makes `runSeat` settle (reject or
 *     resolve) rather than hang.
 */
export interface RunnerContractProbe {
  /** Builds the request for a key; only `idempotencyKey` needs to differ. */
  request(idempotencyKey: string): PanelSeatRequest;
  /**
   * How many runs (`agent_runs` rows, sandbox starts) the runner has started
   * for exactly this key. REQUIRED: a runner that starts (and pays for) a run
   * on every call but hands back a cached `agentRunId` is indistinguishable
   * from an idempotent one without it, so the helper fails the contract
   * when it is missing.
   */
  startedRuns(idempotencyKey: string): Promise<number>;
  /** Prefix that makes the keys unique per invocation. Default: a random one. */
  keyPrefix?: string;
}

export async function checkPanelRunnerContract(runner: PanelRunner, probe: RunnerContractProbe): Promise<string[]> {
  const violations: string[] = [];
  const prefix = probe.keyPrefix ?? `contract:${Math.random().toString(36).slice(2)}`;
  const live = new AbortController().signal;
  const call = (key: string, signal: AbortSignal = live) => runner.runSeat(probe.request(key), signal);

  const seqKey = `${prefix}:sequential`;
  const first = await call(seqKey);
  const second = await call(seqKey);
  if (first.agentRunId !== second.agentRunId) violations.push("two sequential calls with one key returned different runs");

  const concKey = `${prefix}:concurrent`;
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => call(concKey)));
  if (new Set(many.map((r) => r.agentRunId)).size !== 1) violations.push("five concurrent calls with one key returned more than one run");

  const otherKey = `${prefix}:other`;
  const other = await call(otherKey);
  if (other.agentRunId === first.agentRunId || other.agentRunId === many[0]!.agentRunId) {
    violations.push("a different key returned an existing run");
  }

  if (typeof probe.startedRuns !== "function") {
    violations.push("the probe has no startedRuns: run counts are required (a runner that starts a run per call but returns cached ids would pass)");
  } else {
    if ((await probe.startedRuns(seqKey)) !== 1) violations.push("sequential calls with one key started more than one run");
    if ((await probe.startedRuns(concKey)) !== 1) violations.push("concurrent calls with one key started more than one run");
    if ((await probe.startedRuns(otherKey)) !== 1) violations.push("a different key did not start exactly one run of its own");
  }

  // An aborted signal must not leave the call hanging.
  const abortedKey = `${prefix}:aborted`;
  const controller = new AbortController();
  controller.abort();
  const settled = await Promise.race([
    call(abortedKey, controller.signal).then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  if (settled === "hung") violations.push("runSeat did not settle for an already-aborted signal");

  return violations;
}
