// apps/workspace/test/runner-states-ui.test.mjs
//
// D#6 C42-4: how the Runs detail and the Pipeline run section word each state of a run on the person's machine. The inputs are the pinned
// contract fixtures (the bodies the real routes produced against Postgres), one per state; the DOM half is in e2e/runs-runner-states.spec.ts.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { activityLines, costRows, emptyActivityText, factRows, readInsight, runnerEventLine } from "../apps/runs/runs-detail.js";
import { noActivityText, runView, runnerCost } from "../apps/pipeline/pipeline-insight.js";
import { ownPlanLine } from "../apps/pipeline/pipeline-actions.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const names = (op) => readdirSync(join(V1, op)).filter((f) => f.startsWith("200-runner-")).map((f) => f.slice("200-".length, -".json".length));
const read = (op, name) => JSON.parse(readFileSync(join(V1, op, "200-" + name + ".json"), "utf8"));
const insightOf = (name) => readInsight(read("getRunInsight", name));
const pipelineRun = (name) => read("getWorkItemActivity", name).runs[0];

const STATES = names("getRunInsight");
const NOT_ZERO = /\$0(\.00)?(?![\d.])/;

describe("every state of a runner run has a fixture on both screens", () => {
  it("the two operations pin the same states", () => {
    expect(names("getWorkItemActivity")).toEqual(STATES);
    expect(STATES.length).toBeGreaterThanOrEqual(29);
  });
});

describe("the Runs detail, one expectation per state", () => {
  // The model-usage row: value and the detail under it.
  const COST = {
    "runner-succeeded-with-pr": { value: "On your Claude plan · API-equivalent $0.01 · 1,000 in / 200 out tokens", detail: "Estimate, priced at this run's model" },
    "runner-usage-not-priced": { value: "On your Claude plan · no API price for this model · 500 in / 100 out tokens", detail: /not the same as \$0/ },
    "runner-usage-not-recorded": { value: "Not recorded", detail: /not the same as \$0/ },
    "runner-running-activity": { value: "Counting…", detail: null },
    "runner-waiting": { value: "Counting…", detail: null },
  };
  for (const name of STATES) {
    it(name + ": cost is a state with its sentence, never a bare $0", () => {
      const i = insightOf(name);
      const [model, compute] = costRows(i.cost, i.run.status, i.runner_usage ?? null, i.runner_usage_note);
      expect(compute.value).toBe("Ran on your machine: no sandbox compute");
      expect([model.label, model.value, model.detail ?? "", compute.label, compute.value].join(" | ")).not.toMatch(/undefined|null|NaN/);
      expect(model.value).not.toMatch(NOT_ZERO);
      const want = COST[name];
      if (want) {
        expect(model.value).toBe(want.value);
        if (want.detail instanceof RegExp) expect(model.detail).toMatch(want.detail);
        else expect(model.detail).toBe(want.detail);
      }
    });

    it(name + ": the facts say it runs on the runner, and name the check-in only while it is live", () => {
      const i = insightOf(name);
      const rows = factRows(i);
      expect(rows).toContainEqual(["Runs on", "Your runner"]);
      const seen = rows.find((r) => r[0] === "Runner last checked in");
      if (i.runner_checked_in_at) expect(seen[1]).toMatch(/^\d\d:\d\d:\d\d UTC$/);
      else expect(seen).toBeUndefined();
      expect(JSON.stringify(rows)).not.toMatch(/undefined|null|NaN/);
    });

    it(name + ": the activity is the server's lines; an empty one is worded by whether the run is over", () => {
      const i = insightOf(name);
      const lines = activityLines(i);
      if (lines.length === 0) {
        const text = emptyActivityText(i);
        if (i.run.status === "running") expect(text).toBe("Your runner has started; nothing recorded yet");
        else if (i.run.status === "pending") expect(text).toBe("Not started yet; nothing recorded yet.");
        else expect(text).toBe("No activity recorded.");
      }
      for (const l of lines) expect(l.text).not.toMatch(/undefined|null|NaN/);
    });
  }

  it("a run whose runner was lost gets one plain line more, after the lines the server gave", () => {
    const i = insightOf("runner-lease-lost");
    expect(i.failure_reason).toBe("runner_lost");
    expect(activityLines(i).map((l) => l.text)).toEqual(["The run started", "Your runner stopped checking in, so this run was ended. Build again to retry."]);
    // No other run gets it.
    expect(activityLines(insightOf("runner-taken-over")).map((l) => l.text)).toEqual(["The run started", "Taken over on the runner machine"]);
  });

  it("'No activity recorded.' appears only for a finished run", () => {
    for (const status of ["pending", "running"]) for (const runtime of ["runner", "production"]) expect(emptyActivityText({ run: { status, runtime } })).not.toBe("No activity recorded.");
    for (const status of ["succeeded", "failed", "timed_out", "cancelled"]) expect(emptyActivityText({ run: { status, runtime: "runner" } })).toBe("No activity recorded.");
  });

  it("a sandbox run's facts and cost are unchanged", () => {
    const sandbox = readInsight(JSON.parse(readFileSync(join(V1, "getRunInsight", "200-executor-done.json"), "utf8")));
    expect(factRows(sandbox).map((r) => r[0])).not.toContain("Runs on");
    expect(costRows(sandbox.cost, sandbox.run.status, undefined, undefined)[1].label).toBe("Sandbox compute");
  });
});

describe("the runner's own events in the event list", () => {
  it("a tool use that carries its activity reads as the sandbox's lines do", () => {
    expect(runnerEventLine({ type: "tool_use", tool_name: "Bash", activity: { tool: "test", command: "pnpm test" } })).toBe("Ran tests: pnpm test");
    expect(runnerEventLine({ type: "tool_use", tool_name: "Bash", activity: { tool: "command", command: "ls src" } })).toBe("Ran: ls src");
    expect(runnerEventLine({ type: "tool_use", tool_name: "Bash", activity: { tool: "command" } })).toBe("Running a command");
    expect(runnerEventLine({ type: "tool_use", tool_name: "Bash", activity: { tool: "test" } })).toBe("Running the tests");
    expect(runnerEventLine({ type: "tool_use", tool_name: "Read", file_path: "src/a.ts" })).toBe("Used Read · src/a.ts");
  });
  it("a command is text, never markup", () => {
    expect(runnerEventLine({ type: "tool_use", activity: { tool: "command", command: "<img src=x onerror=alert(1)>" } })).toBe("Ran: <img src=x onerror=alert(1)>");
  });
  it("the three stages are worded as the sandbox's are, and an unknown one is a plain step", () => {
    expect(runnerEventLine({ type: "stage", stage: "workspace_ready" })).toBe("The secure sandbox is ready");
    expect(runnerEventLine({ type: "stage", stage: "cloned" })).toBe("Repository cloned");
    expect(runnerEventLine({ type: "stage", stage: "writing_result" })).toBe("Writing up the result");
    expect(runnerEventLine({ type: "stage", stage: "later" })).toBe("Runner step");
  });
});

describe("the Pipeline run section, one expectation per state", () => {
  const HEAD = {
    "runner-succeeded-with-pr": "≈ $0.01 at API prices · on your plan",
    "runner-usage-not-priced": "usage not priced",
  };
  for (const name of STATES) {
    it(name + ": cost reads the usage state, never a null spend as $0", () => {
      const run = pipelineRun(name);
      const v = runView(run);
      expect(v.runner).toBe(true);
      expect(v.cost).not.toMatch(NOT_ZERO);
      expect(v.cost).not.toMatch(/undefined|null|NaN/);
      // A finished run with no usage says so; a live one has nothing to say yet.
      const expected = HEAD[name] ?? (run.runner_usage_state === "not_recorded" ? "usage not recorded" : "");
      expect(v.cost).toBe(expected);
      if (run.status === "pending" || run.status === "running") expect(v.cost).toBe("");
      // The sentence for a state with no figure travels with it.
      if (run.runner_usage_state === "not_priced" || run.runner_usage_state === "not_recorded") expect(v.costNote).toMatch(/not the same as \$0/);
      else expect(v.costNote).toBeNull();
      // Wait and check-in belong to the live states only.
      expect(v.waitText !== null).toBe(run.status === "pending" && run.wait != null);
      expect(v.checkedIn !== null).toBe(run.status === "running" && typeof run.runner_checked_in_at === "string");
      expect(v.attachHint).toBe(run.status === "pending" || run.status === "running");
    });
  }

  it("a run with no lines says 'No activity recorded.' only once it is over", () => {
    expect(noActivityText({ status: "running", runtime: "runner" })).toBe("Your runner has started; nothing recorded yet");
    expect(noActivityText({ status: "pending", runtime: "runner" })).toBe("Not started yet; nothing recorded yet.");
    expect(noActivityText({ status: "running", runtime: "production" })).toBe("Nothing recorded yet.");
    expect(noActivityText({ status: "failed", runtime: "runner" })).toBe("No activity recorded.");
    expect(noActivityText({ status: "succeeded", runtime: "production" })).toBe("No activity recorded.");
  });

  it("runnerCost words an API-key run and a run with tokens but no price", () => {
    expect(runnerCost({ runner_usage: { credential_mode: "api_key", api_equivalent_usd: 1.5 } }).head).toBe("≈ $1.50 at API prices · on your own API key");
    expect(runnerCost({ runner_usage: { credential_mode: "subscription", api_equivalent_usd: null }, runner_usage_note: "n" })).toEqual({ head: "usage not priced", note: "n" });
  });

  it("a sandbox run keeps its spend figure", () => {
    expect(runView({ id: "x", role: "executor", status: "succeeded", usd: 2.5, lines: [] }).cost).toBe("$2.50");
  });
});

describe("the item's own-plan line (C42-5 states)", () => {
  const tokens = { input: 182000, output: 9400, cache_read: 0, cache_write: 0 };
  it("a recorded figure reads as before; a real zero says nothing", () => {
    expect(ownPlanLine({ own_plan_usage_state: "recorded", own_plan_api_equivalent_usd: 3.5, own_plan_tokens: tokens })).toBe("On your own plan (API-equivalent): $3.50");
    expect(ownPlanLine({ own_plan_usage_state: "recorded", own_plan_api_equivalent_usd: 0, own_plan_tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } })).toBeNull();
  });
  it("not priced shows the tokens, and not recorded says so, each apart from $0", () => {
    expect(ownPlanLine({ own_plan_usage_state: "not_priced", own_plan_api_equivalent_usd: null, own_plan_tokens: tokens })).toBe("On your own plan: 182,000 in / 9,400 out tokens, with no API price for the model. That is not the same as $0.");
    expect(ownPlanLine({ own_plan_usage_state: "not_recorded", own_plan_api_equivalent_usd: null, own_plan_tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } })).toBe("On your own plan: usage was not recorded for a finished run. That is not the same as $0.");
  });
  it("an older server (no state) and a missing item are read as before", () => {
    expect(ownPlanLine({ own_plan_api_equivalent_usd: 2.5 })).toBe("On your own plan (API-equivalent): $2.50");
    expect(ownPlanLine(null)).toBeNull();
    expect(ownPlanLine({})).toBeNull();
  });
});
