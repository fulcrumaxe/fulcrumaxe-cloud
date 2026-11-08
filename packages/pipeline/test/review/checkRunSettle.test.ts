import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_RUN_INCONSISTENT_EVENT, settleCheckRun } from "../../src/build/checkRunSettle.js";
import type { CiSnapshot } from "../../src/build/mergeGate.js";
import { gate1ReadsFor } from "../../src/review/gate1Attest.js";
import { readCiWaitNamed } from "../../src/review/ciWait.js";
import { fakeGitHubRest, freshRepo } from "./helpers/fakeGitHubRest.js";
import { fakeGitHubLocal, gate1World } from "./helpers/fakeGitHubLocal.js";

/** A check run GitHub reports `in_progress` with a conclusion and a completion time has finished; every reader of check runs says so. */
const HEAD = "d".repeat(40);
const DONE = "2026-11-07T10:00:00Z";
const head = { owner: "acme", name: "widgets", sha: HEAD, number: 41 };

describe("settleCheckRun", () => {
  it.each(["success", "failure"])("a run with conclusion %s and a completion time is completed whatever its status says, and one fixed line is logged", (conclusion) => {
    const lines: string[] = [];
    expect(settleCheckRun({ status: "in_progress", conclusion, completedAt: DONE }, (l) => lines.push(l))).toEqual({ status: "completed", conclusion });
    expect(lines).toEqual([JSON.stringify({ event: CHECK_RUN_INCONSISTENT_EVENT })]);
  });

  it("a run that is really running, or only half reported, is left alone and logs nothing", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(settleCheckRun({ status: "in_progress", conclusion: null, completedAt: null }, log)).toEqual({ status: "in_progress", conclusion: null });
    expect(settleCheckRun({ status: "in_progress", conclusion: "success", completedAt: null }, log).status).toBe("in_progress");
    expect(settleCheckRun({ status: "in_progress", conclusion: "success" }, log).status).toBe("in_progress");
    expect(settleCheckRun({ status: "in_progress", conclusion: null, completedAt: DONE }, log).status).toBe("in_progress");
    expect(settleCheckRun({ status: "completed", conclusion: "success", completedAt: DONE }, log).status).toBe("completed");
    expect(lines).toEqual([]);
  });
});

describe("the readers", () => {
  const checks = [
    { name: "pr-gates", status: "in_progress", conclusion: "success", completedAt: DONE },
    { name: "failed", status: "queued", conclusion: "failure", completedAt: DONE },
    { name: "still-going", status: "in_progress", conclusion: null, completedAt: null },
  ];
  const expected = [
    { name: "pr-gates", status: "completed", conclusion: "success" },
    { name: "failed", status: "completed", conclusion: "failure" },
    { name: "still-going", status: "in_progress", conclusion: null },
  ];

  it("the attester's hosted REST read counts the half-updated run completed and a genuinely running one running", async () => {
    const reads = gate1ReadsFor(fakeGitHubRest(freshRepo({ headSha: HEAD, checks: { [HEAD]: checks } }), { gate1: gate1World() }), head);
    expect((await reads.checkRuns()).runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))).toEqual(expected);
  });

  it("the attester's fenced document read does the same", async () => {
    const local = fakeGitHubLocal(freshRepo({ headSha: HEAD, checks: { [HEAD]: checks } }), { exclude: ["A10"], gate1: gate1World() });
    expect((await gate1ReadsFor(local.http, head).checkRuns()).runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))).toEqual(expected);
  });

  it("every source file that parses check runs from GitHub passes them through settleCheckRun", () => {
    // A file that reads GitHub check runs (the REST list or the GraphQL CheckRun fragment) must use the helper; the few that only write
    // a document string or a receipt's timing are named here with the reason.
    const NOT_A_DECISION_READER = new Set(["runner-cloud/src/localOnlyGithub.ts", "receipts/src/block.ts", "github/src/installationHttp.ts", "worker/src/receiptBlock.ts"]);
    const packages = new URL("../../../", import.meta.url).pathname;
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const readers: string[] = [];
    for (const pkg of readdirSync(packages)) {
      const src = join(packages, pkg, "src");
      if (!existsSync(src)) continue;
      for (const file of walk(src)) {
        const text = readFileSync(file, "utf8");
        const rel = `${pkg}/src/${file.slice(src.length + 1)}`;
        if (!/\/check-runs|check_runs\b|__typename === "CheckRun"|__typename !== "CheckRun"/.test(text) || NOT_A_DECISION_READER.has(rel)) continue;
        readers.push(rel);
        expect(text, rel).toMatch(/\bsettleCheckRun\(/);
      }
    }
    expect(readers.sort()).toEqual(["pipeline/src/build/githubMergePort.ts", "pipeline/src/review/gate1Attest.ts", "pipeline/src/review/gate1QueueEntry.ts"]);
  });
});

describe("what the wait names when it stops", () => {
  const snap = (over: Partial<CiSnapshot>): CiSnapshot => ({ headSha: HEAD, checkRuns: [], checkRunsTotalCount: 0, statuses: [], statusesTotalCount: 0, requiredContexts: [], requiredAppChecks: [], ...over });

  it("lists the unfinished checks and statuses by name, sorted, and not the finished ones", () => {
    const runs = [
      { name: "zeta", status: "in_progress", conclusion: null },
      { name: "alpha", status: "queued", conclusion: null },
      { name: "done", status: "completed", conclusion: "success" },
    ];
    const reading = readCiWaitNamed(snap({ checkRuns: runs, checkRunsTotalCount: 3, statuses: [{ context: "ci/old", state: "pending" }], statusesTotalCount: 1 }), HEAD);
    expect(reading.reasons).toEqual(["check_running", "status_pending"]);
    expect(reading.running).toEqual(["alpha", "ci/old", "zeta"]);
  });

  it("a settled head names nothing", () => {
    expect(readCiWaitNamed(snap({ checkRuns: [{ name: "a", status: "completed", conclusion: "success" }], checkRunsTotalCount: 1 }), HEAD).running).toBeUndefined();
  });
});
