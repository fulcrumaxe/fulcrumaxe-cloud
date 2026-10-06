import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_START_TIMEOUT_MS } from "@fx/runner";

/**
 * A preview's perform now waits for the agent command to exist (up to the start window) after the sandbox is created.
 * If the run-action claim lease were shorter than that, the minute sweep would claim the same action again while the
 * first perform is still waiting and run a second perform. The lease is pinned against the window here, in the one
 * package that can see both (the pipeline package does not depend on the runner).
 */
describe("run-action claim lease vs the agent start window", () => {
  it("is longer than the start window by at least two minutes (sandbox create and the writes around the wait)", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pipeline", "src", "runActions", "workflow.ts"), "utf8");
    const lease = Number(/export const CLAIM_LEASE_SECONDS = (\d+);/.exec(source)?.[1]);
    expect(Number.isInteger(lease)).toBe(true);
    expect(lease * 1000).toBeGreaterThanOrEqual(AGENT_START_TIMEOUT_MS + 120_000);
    expect(lease).toBeLessThanOrEqual(3600); // the definer's own ceiling
  });
});
