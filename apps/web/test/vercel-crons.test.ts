import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * D#454 H3c: pins the three sweep schedules in apps/web/vercel.json. The sweeps used to run every minute, which kept
 * the staging Neon compute awake; the schedules below are the agreed cadence, and the marker gate
 * (packages/core pendingWork.ts) is what lets most ticks end without a connection. Written by hand, not derived from
 * the file. It checks these three entries and the file's shape, not the number of crons, so another PR may add its own.
 */
const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { crons: Array<{ path: string; schedule: string }> };

const EXPECTED: Record<string, string> = {
  "/api/cron/api-sweep": "*/5 * * * *",
  "/api/cron/run-action-sweep": "*/5 * * * *",
  "/api/cron/compute-settle-sweep": "*/10 * * * *",
};

describe("apps/web/vercel.json", () => {
  it.each(Object.entries(EXPECTED))("%s runs on %s", (path, schedule) => {
    expect(config.crons.filter((c) => c.path === path)).toEqual([{ path, schedule }]);
  });

  it("the runner sweeper (D#6 R2b, C14 section 4) runs every 5 minutes through the shared pending-work gate: every timer is a 'not before' rule, so the cadence only adds up to 5 minutes of delay", () => {
    expect(config.crons.filter((c) => c.path === "/api/cron/runner-sweeper")).toEqual([{ path: "/api/cron/runner-sweeper", schedule: "*/5 * * * *" }]);
  });

  it("changes nothing else: a crons list (each entry just a path and a schedule, no sweep at every minute) and the workflow step's function limit (pinned in stepMaxDuration.test.ts)", () => {
    expect(Object.keys(config)).toEqual(["functions", "crons"]);
    for (const cron of config.crons) expect(Object.keys(cron).sort()).toEqual(["path", "schedule"]);
    for (const path of [...Object.keys(EXPECTED), "/api/cron/runner-sweeper"]) expect(config.crons.find((c) => c.path === path)?.schedule).not.toBe("* * * * *");
  });
});
