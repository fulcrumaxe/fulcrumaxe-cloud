import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { setPendingHooks, type SweepName } from "@fx/core/src/pendingWork.js";
import { writeRunStatusOn } from "../src/runStatusWriter.js";

/**
 * D#749: a finished post-merge tester run is what the verify stage waits on, so the run status writer wakes the verify sweep (marker and kick) when a
 * deploy-verifier run reaches a terminal status. The end of any other role's run, and a tester run that merely starts, wakes nothing. (Lives in this package,
 * not in apps/web: the request path may not import the runner's writers.)
 */
const NOW = 1_800_000_000_000;
const entries = new Map<string, number>();
const kicks: SweepName[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setPendingHooks({
    store: { get: async (key) => entries.get(key) ?? null, set: async (key, value) => void entries.set(key, value), delete: async (key) => void entries.delete(key) },
    kick: (name) => void kicks.push(name),
  });
});
afterEach(() => {
  setPendingHooks(null);
  entries.clear();
  kicks.length = 0;
  vi.useRealTimers();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a run reaching a terminal status (writeRunStatusOn)", () => {
  /** A client whose status function accepts the move and whose role read answers `role`. */
  const clientFor = (role: string): PoolClient =>
    ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("agent_run_set_status")) return { rows: [{ updated: true }] };
        if (sql.includes("SELECT role FROM agent_runs")) return { rows: [{ role }] };
        return { rows: [{ id: "evt_1" }] };
      }),
    }) as unknown as PoolClient;
  const finish = async (role: string, to: "succeeded" | "failed" | "timed_out" | "cancelled" | "running", from: "running" | "pending" = "running") => {
    await writeRunStatusOn(clientFor(role), { accountId: "a", runId: "r", from, to });
    await flush();
  };

  it.each(["succeeded", "failed", "timed_out", "cancelled"] as const)("a deploy-verifier run that ends %s marks and kicks the verify sweep", async (to) => {
    await finish("deploy-verifier", to);
    expect(entries.get("pending:proposal-verify-sweep")).toBe(NOW);
    expect(kicks.filter((k) => k === "proposal-verify-sweep")).toEqual(["proposal-verify-sweep"]);
  });

  it.each(["executor", "code-reviewer", "proposal-verifier", "discovery-analyst"])("a %s run that ends does nothing for the verify stage", async (role) => {
    await finish(role, "succeeded");
    expect(entries.has("pending:proposal-verify-sweep")).toBe(false);
    expect(kicks).not.toContain("proposal-verify-sweep");
  });

  it("a deploy-verifier run that starts (not terminal) does not wake the stage", async () => {
    await finish("deploy-verifier", "running", "pending");
    expect(kicks).not.toContain("proposal-verify-sweep");
  });
});
