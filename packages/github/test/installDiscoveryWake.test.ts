import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

// D#483 S4-c2 follow-up: the install paths tell the app a run was queued, and only when one was.
const queued = vi.hoisted(() => ({ runs: [] as { id: string; repoId: string }[] }));
vi.mock("@fx/db/src/discoveryRuns.js", () => ({ queueDiscoveries: vi.fn(async () => queued.runs) }));
vi.mock("@fx/core/src/tenancy/withPlatformOps.js", () => ({ withPlatformOps: vi.fn(async () => "inst-1") }));

import { queueInstallDiscovery } from "../src/installDiscovery.js";

const pool = {} as Pool;
const run = async (runs: { id: string; repoId: string }[]) => {
  queued.runs = runs;
  const onDiscoveryQueued = vi.fn(async () => undefined);
  await queueInstallDiscovery({ platformOpsPool: pool, appUserPool: pool, onDiscoveryQueued, warn: () => undefined }, "team", "acct", 42);
  return onDiscoveryQueued;
};

describe("queueInstallDiscovery wake hook", () => {
  it("is called with the queued runs", async () => {
    const hook = await run([{ id: "r1", repoId: "p1" }]);
    expect(hook).toHaveBeenCalledWith("acct", [{ id: "r1", repoId: "p1" }]);
  });
  it("is not called for a no-op queue", async () => {
    expect(await run([])).not.toHaveBeenCalled();
  });
});
