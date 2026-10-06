import { readFile } from "node:fs/promises";
import type { AgentHandle, AgentRuntime, NormalizedEvent, StartOptions } from "../types.js";

/**
 * Runner (fake): replays a recorded fixture `.jsonl` — one `NormalizedEvent`
 * per line — instead of driving a model. Zero model tokens, used by every
 * automated test and by `selectRuntime` under `FX_FORBID_MODEL_CALLS=1` /
 * `VITEST` / `NODE_ENV=test` (Spec H04 pass/fail 5).
 */
export interface FakeHandle extends AgentHandle {
  _fixturePath?: string;
  _opts?: StartOptions;
}

async function readFixtureEvents(fixturePath: string): Promise<NormalizedEvent[]> {
  const raw = await readFile(fixturePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NormalizedEvent);
}

/** Resolve the fixture path for a role. `fixtureName` picks a specific file
 * (without the `.jsonl` extension) among a role's fixtures; defaults to
 * `sample-1`, the one every seeded role ships. */
export function fixturePathFor(fixtureDir: string, role: string, fixtureName = "sample-1"): string {
  return `${fixtureDir}/${role}/${fixtureName}.jsonl`;
}

export function createFakeRuntime(fixtureDir: string): AgentRuntime {
  async function replay(
    opts: StartOptions,
    fixturePath: string,
    runId: string,
  ): Promise<{ handle: AgentHandle }> {
    const recorded = await readFixtureEvents(fixturePath);
    let sessionId: string | undefined;
    for (const event of recorded) {
      const rebased: NormalizedEvent = { ...event, runId };
      sessionId = rebased.sessionId ?? sessionId;
      await opts.onEvent(rebased);
    }
    const handle: FakeHandle = { runId, sessionId, _fixturePath: fixturePath, _opts: opts };
    return { handle };
  }

  return {
    async start(opts) {
      const fixtureName = (opts as { fixtureName?: string }).fixtureName;
      const fixturePath = fixturePathFor(fixtureDir, opts.role, fixtureName);
      return replay(opts, fixturePath, opts.runId);
    },
    async stop() {
      // No process to stop — replay already ran to completion synchronously
      // per fixture line.
    },
    async resume(handle, sessionId, prompt) {
      const fakeHandle = handle as FakeHandle;
      const fixturePath = fakeHandle._fixturePath;
      const priorOpts = fakeHandle._opts;
      if (!fixturePath || !priorOpts) {
        throw new Error("cannot resume: handle was not produced by the fake runtime");
      }
      return replay({ ...priorOpts, prompt }, fixturePath, handle.runId);
    },
  };
}
