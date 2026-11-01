import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** D#483 S5-g2, S5g-4 and R-597-1: the sweep only queues. Its imports are the two queues and the tenant session; no stage driver, start gate, approval, work item, run or spend counter. */
const SRC = readFileSync(new URL("../src/discoverySchedule.ts", import.meta.url), "utf8");
const specifiers = [...SRC.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);

describe("the sweep's imports (R-597-1)", () => {
  it("imports the queues and nothing of the stage driver, start gate, approval, work items, runs or spend, and names no table of work or spend", () => {
    expect(specifiers).toContain("@fx/db/src/discoveryRuns.js");
    expect(specifiers).toContain("@fx/db/src/discoveryAnalyses.js");
    for (const s of specifiers) expect(s, s).not.toMatch(/advance|stage|start-?gate|startGate|approve|work-?items?|runActions|receipt|dial|autoStart|pipeline|runner|proposalVerifyLimits|candidates/i);
    for (const table of ["work_items", "run_action_requests", "start_gate", "approvals", "agent_runs", "ledger", "proposals"]) expect(SRC, table).not.toContain(table);
    expect([...SRC.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/gi)]).toEqual([]);
  });
});
