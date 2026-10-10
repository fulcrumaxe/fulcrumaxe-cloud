// apps/workspace/test/runner-parity.test.mjs
//
// D#6 C42-4: Runs and Pipeline draw a run on the person's own machine the way they draw a sandbox run. The model halves of both
// (runs-detail.js, pipeline-insight.js, pipeline-actions.js; all pure), tested on the real route outputs pinned in
// packages/api/fixtures/v1 (the C42-3 and C42-3b fixtures that test/runner-run-states and runner-run-wait pin against Postgres),
// one case per state. The DOM half, at desktop, tablet and phone, is in e2e/runs-runner-states.spec.ts and
// e2e/pipeline-runner-states.spec.ts; the pixel comparison with a sandbox run is in e2e/runner-parity-pixels.spec.ts.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ATTACH_HINT, buildInsight, clockText as plClock, runView, runnerView, SENTENCES } from "../apps/pipeline/pipeline-insight.js";
import { ownPlanText } from "../apps/pipeline/pipeline-actions.js";
import { NOT_PRICED, NOT_RECORDED, RUNS } from "../e2e/helpers/runner-states.mjs";
import { clockText, costRows, factRows, noActivityView, readInsight, waitSentence } from "../apps/runs/runs-detail.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (op, name) => JSON.parse(readFileSync(join(V1, op, name), "utf8"));
const names = (op) => readdirSync(join(V1, op)).filter((f) => f.startsWith("200-runner-")).sort();

beforeAll(() => {
  process.env.TZ = "UTC"; // the check-in time is the viewer's clock; pin it
});

const BAD = /\b(null|undefined|NaN)\b/;
/** Every string a model holds (what the screen can print), joined. A JSON null is not text, but the word null inside text is a hole. */
const texts = (v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === "object" ? Object.values(v).flatMap(texts) : []);
const holeFree = (v) => expect(texts(v).join("\n")).not.toMatch(BAD);

describe("the Runs detail draws every state of a run on the person's machine (C42-4)", () => {
  it("has a case for every pinned runner fixture, and no case without one", () => {
    expect(Object.keys(RUNS).sort()).toEqual(names("getRunInsight"));
  });

  for (const [file, want] of Object.entries(RUNS)) {
    it(`${file}`, () => {
      const raw = fx("getRunInsight", file);
      const ins = readInsight(raw);
      expect(ins).not.toBeNull();
      expect(waitSentence(ins)).toBe(want.wait);
      const [model, compute] = costRows(ins.cost, ins.run.status, ins.run.runtime === "runner" ? ins.runner_usage : undefined, { state: ins.runner_usage_state, note: ins.runner_usage_note });
      expect(model.value).toBe(want.cost.value);
      expect(model.detail).toBe(want.cost.detail);
      expect(compute.value).toBe("Ran on your machine: no sandbox compute");
      const facts = Object.fromEntries(factRows(ins).map(([k, v]) => [k, v]));
      expect(facts["Runs on"]).toBe("your runner");
      expect(facts["Runner last checked in"] ?? null).toBe(want.checkedIn ?? null);
      if (ins.lines.length === 0 && want.empty !== undefined) expect(noActivityView(ins)).toEqual(want.empty);
      // no hole in anything drawn from the state
      holeFree([want.wait, model, compute, factRows(ins), noActivityView(ins)]);
    });
  }

  it("a null figure is never drawn as $0: the only $0 on screen is a real zero", () => {
    const base = readInsight(fx("getRunInsight", "200-runner-usage-not-priced.json"));
    const [model] = costRows(base.cost, "succeeded", { ...base.runner_usage, api_equivalent_usd: null }, { state: "not_priced", note: NOT_PRICED });
    expect(model.value).not.toMatch(/\$/);
    const [zero] = costRows(base.cost, "succeeded", { ...base.runner_usage, api_equivalent_usd: 0 }, { state: "recorded", note: null });
    expect(zero.value).toContain("API-equivalent $0.00");
    const [none] = costRows(base.cost, "succeeded", null, { state: "not_recorded", note: NOT_RECORDED });
    expect(none.value).toBe("Not recorded");
    expect(none.value).not.toMatch(/\$/);
    // a server that sends no state (an older one) keeps the earlier words
    expect(costRows(base.cost, "succeeded", null)[0].value).toBe("Not recorded");
    expect(costRows(base.cost, "running", null)[0].value).toBe("Counting…");
  });

  it("'No activity recorded.' is for a finished run only; a run still going says it has recorded nothing yet", () => {
    const run = (status, runtime) => ({ run: { status, runtime }, lines: [] });
    for (const status of ["succeeded", "failed", "timed_out", "cancelled", "killed_spend", "refused_spend"]) {
      expect(noActivityView(run(status, "runner"))).toEqual({ testid: "runs-no-activity", text: "No activity recorded." });
      expect(noActivityView(run(status, "production"))).toEqual({ testid: "runs-no-activity", text: "No activity recorded." });
    }
    expect(noActivityView(run("running", "runner"))).toEqual({ testid: "runs-nothing-yet", text: "Your runner has started; nothing recorded yet" });
    expect(noActivityView(run("running", "production"))).toEqual({ testid: "runs-nothing-yet", text: "Nothing recorded yet." });
    expect(noActivityView(run("pending", "production"))).toEqual({ testid: "runs-nothing-yet", text: "Nothing recorded yet." });
    expect(noActivityView(run("pending", "runner"))).toEqual({ testid: "runs-nothing-yet", text: "Not started yet; nothing recorded yet." });
    // a queued runner run that has a wait says that instead
    expect(noActivityView({ ...run("pending", "runner"), wait: { text: "Waiting for your runner to come online" } })).toBeNull();
  });

  it("a sandbox run's facts and cost are what they were: no runner row, no state", () => {
    const sandbox = readInsight(fx("getRunInsight", "200-executor-done.json"));
    expect(factRows(sandbox).map(([k]) => k)).not.toContain("Runs on");
    expect(factRows(sandbox).map(([k]) => k)).not.toContain("Runner last checked in");
    expect(waitSentence(sandbox)).toBeNull();
    expect(costRows(sandbox.cost, sandbox.run.status, undefined, { state: "recorded", note: "x" })[1].label).toBe("Sandbox compute");
  });

  it("the check-in time is HH:MM:SS, and a malformed one is nothing, never 'Invalid Date' or NaN", () => {
    expect(clockText("2026-10-03T10:03:30.000Z")).toBe("10:03:30");
    expect(plClock("2026-10-03T10:03:30.000Z")).toBe("10:03:30");
    for (const bad of [null, undefined, "", "yesterday", "2026-13-45T99:00:00Z", 5, {}]) {
      expect(clockText(bad)).toBeNull();
      expect(plClock(bad)).toBeNull();
    }
  });
});

const PL = Object.fromEntries(
  names("getWorkItemActivity").map((file) => [file, file.replace(/^200-runner-/, "").replace(/\.json$/, "")]),
);

describe("the Pipeline run section draws every state of a run on the person's machine (C42-4)", () => {
  it("has a fixture for every Runs state", () => {
    expect(names("getWorkItemActivity")).toEqual(names("getRunInsight"));
  });

  for (const file of Object.keys(PL)) {
    it(`${file}`, () => {
      const want = RUNS[file];
      const data = fx("getWorkItemActivity", file);
      const [r] = data.runs;
      const v = runView(r);
      expect(v.runner).not.toBeNull();
      expect(v.runner.wait).toBe(want.wait);
      expect(v.runner.checkedIn).toBe(want.checkedIn ?? null);
      expect(v.runner.started).toBe(r.status === "running");
      // cost: the usage line when the cloud priced or counted tokens; the state's own words when it did not; nothing for a run still going
      const state = r.runner_usage_state;
      if (state === "recorded") expect(v.runner.cost).toMatch(/^On your Claude plan · API-equivalent \$\d+\.\d\d · [\d,]+ in \/ [\d,]+ out tokens$/);
      else if (state === "not_priced") {
        expect(v.runner.cost).toMatch(/no API price for this model/);
        expect(v.runner.costNote).toBe(NOT_PRICED);
      } else if (state === "not_recorded") {
        expect(v.runner.cost).toBe("Cost not recorded");
        expect(v.runner.costNote).toBe(NOT_RECORDED);
      } else {
        expect(v.runner.cost).toBeNull();
        expect(v.runner.costNote).toBeNull();
      }
      // the section's head never draws a null figure as $0
      expect(v.cost).toBe("");
      holeFree(v);
      holeFree(buildInsight(data).runs);
    });
  }

  it("the lines of a runner run are the run section's lines, the same as a sandbox run's", () => {
    const data = fx("getWorkItemActivity", "200-runner-running-activity.json");
    expect(runView(data.runs[0]).lines).toEqual(data.runs[0].lines.map((l) => l.text));
    expect(runView(data.runs[0]).lines).toContain("Ran tests: pnpm test");
  });

  it("a sandbox run is drawn exactly as before: no runner view, its dollar figure in the head", () => {
    const ok = fx("getWorkItemActivity", "200-ok.json");
    for (const r of ok.runs) {
      const v = runView(r);
      expect(v.runner).toBeNull();
      expect(v.cost).toBe(Number.isFinite(r.usd) ? "$" + r.usd.toFixed(2) : "");
    }
  });

  it("the attach hint is text, names the command, and is for a run that has started", () => {
    expect(ATTACH_HINT).toBe("You can also watch this run on the runner machine with `fx-runner attach`.");
    expect(runnerView({ runtime: "runner", status: "running" }).started).toBe(true);
    expect(runnerView({ runtime: "runner", status: "pending" }).started).toBe(false);
    expect(runnerView({ runtime: "production", status: "running" })).toBeNull();
  });

  it("an empty runner run says so by its state; a finished one keeps the earlier sentence", () => {
    expect(SENTENCES.runnerStarted).toBe("Your runner has started; nothing recorded yet");
    expect(SENTENCES.notStarted).toBe("Not started yet; nothing recorded yet.");
    expect(SENTENCES.noActivity).toBe("No activity recorded for this run yet.");
  });
});

describe("the item's own-plan cost states (C42-5) are words, never a silent $0", () => {
  const tokens = { input: 182000, output: 9400, cache_read: 0, cache_write: 0 };
  it("recorded shows the figure, and a real zero shows nothing", () => {
    expect(ownPlanText(3.5, "recorded", tokens)).toBe("On your own plan (API-equivalent): $3.50");
    expect(ownPlanText(0, "recorded", tokens)).toBeNull();
    expect(ownPlanText(3.5)).toBe("On your own plan (API-equivalent): $3.50");
  });
  it("not_priced shows the tokens and says there is no price", () => {
    const t = ownPlanText(null, "not_priced", tokens);
    expect(t).toBe("On your own plan: 182,000 in / 9,400 out tokens recorded, but no API price for the model yet (that is not $0)");
    holeFree(t);
    expect(ownPlanText(null, "not_priced", undefined)).toBe("On your own plan: tokens recorded, but no API price for the model yet (that is not $0)");
  });
  it("not_recorded says a finished run reported no usage", () => {
    expect(ownPlanText(null, "not_recorded", tokens)).toBe("On your own plan: a finished run reported no usage, so there is no estimate (that is not $0)");
  });
  it("a figure that is null, NaN or not a number is not drawn at all", () => {
    for (const bad of [null, undefined, NaN, "3", {}]) expect(ownPlanText(bad, "recorded", tokens)).toBeNull();
  });
});
