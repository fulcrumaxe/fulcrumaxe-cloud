// apps/workspace/test/runs-detail.test.mjs
//
// D#483 P5: the Runs detail's model half (runs-detail.js, pure), on the contract fixtures for every state. The DOM half
// (collapsing, overflow on phone and tablet, hostile text under the production CSP) is in e2e/runs-detail.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { costRows, durationText, factRows, failureText, githubLinks, isReviewer, readInsight, titleOf, verdictView } from "../apps/runs/runs-detail.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const fx = (name) => JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", "getRunInsight", name), "utf8"));
const REVIEW = fx("200-review-needs-fix.json");
const EXEC = fx("200-executor-done.json");
const BARE = fx("200-running-bare.json");

describe("titles and verdicts", () => {
  it("names a role with its phase, and an unknown role plainly", () => {
    expect(titleOf("code-reviewer")).toBe("Review · Code reviewer");
    expect(titleOf("executor")).toBe("Build · Executor");
    expect(titleOf("something-new")).toBe("something new");
    expect(titleOf("")).toBe("Agent run");
    expect(titleOf(undefined)).toBe("Agent run");
  });
  it("labels the three review verdicts, shows another word as itself, and says nothing for none", () => {
    expect(verdictView("pass")).toEqual({ label: "Pass", tone: "ok" });
    expect(verdictView("needs-fix")).toEqual({ label: "Needs fix", tone: "warn" });
    expect(verdictView("fail")).toEqual({ label: "Fail", tone: "bad" });
    expect(verdictView("checkpoint")).toEqual({ label: "checkpoint", tone: "plain" });
    for (const none of [null, undefined, "", 5]) expect(verdictView(none)).toBeNull();
  });
  it("knows which roles review", () => {
    expect(isReviewer("code-reviewer")).toBe(true);
    expect(isReviewer("executor")).toBe(false);
  });
});

describe("duration", () => {
  it("measures a finished run between its two instants and a live run to the server's clock", () => {
    expect(durationText(REVIEW.run, REVIEW.server_time)).toBe("12m 30s");
    expect(durationText({ started_at: "2026-10-03T10:00:00Z", ended_at: null }, "2026-10-03T10:00:42Z")).toBe("42s");
    expect(durationText({ started_at: "2026-10-03T10:00:00Z", ended_at: "2026-10-03T12:05:00Z" }, "")).toBe("2h 05m");
  });
  it("says nothing when the run never started or the times are wrong", () => {
    expect(durationText({ started_at: null, ended_at: null }, "2026-10-03T10:00:00Z")).toBeNull();
    expect(durationText({ started_at: "2026-10-03T10:10:00Z", ended_at: "2026-10-03T10:00:00Z" }, "")).toBeNull();
    expect(durationText({ started_at: "nope", ended_at: null }, "also nope")).toBeNull();
  });
});

describe("cost: model and compute are separate, each with whose bill it is on", () => {
  it("shows a customer-key run's model usage with its tokens and key, and compute apart", () => {
    const [model, compute] = costRows(REVIEW.cost, "succeeded");
    expect(model).toMatchObject({ key: "model", label: "Model usage", value: "$1.23", bill: "On your Anthropic key", detail: "182,000 in, 9,400 out" });
    expect(compute).toMatchObject({ key: "compute", label: "Sandbox compute", value: "$0.04", bill: "Sandbox compute, billed to the workspace" });
  });
  it("shows an operator-subscription run as no per-token charge, on the operator's subscription", () => {
    const [model] = costRows(EXEC.cost, "succeeded");
    expect(model).toMatchObject({ value: "No per-token charge", bill: "On the operator's subscription" });
  });
  it("names the gateway key too", () => {
    expect(costRows({ model: { usd: 2, source: "customer_gateway" }, compute: {} }, "succeeded")[0].bill).toBe("On your AI Gateway key");
  });
  it("says counting or settled-later while a run goes, and not recorded once it ended with nothing", () => {
    const live = costRows(BARE.cost, "running");
    expect(live[0].value).toBe("Counting…");
    expect(live[1].value).toBe("Settled when the run ends");
    const done = costRows(BARE.cost, "failed");
    expect(done.map((r) => r.value)).toEqual(["Not recorded", "Not recorded"]);
    expect(done.every((r) => r.bill === null)).toBe(true);
  });
  it("copes with a missing cost object", () => {
    expect(costRows(undefined, "succeeded").map((r) => r.value)).toEqual(["Not recorded", "Not recorded"]);
  });
});

describe("facts and links", () => {
  it("lists what was recorded: model, the 7-character head commit, the limits now set", () => {
    const rows = factRows(REVIEW);
    expect(rows.find((r) => r[0] === "Model")[1]).toBe("sonnet-5");
    expect(rows.find((r) => r[0] === "Head commit")).toEqual(["Head commit", "9b708c1", REVIEW.run.head_sha]);
    expect(rows.find((r) => r[0] === "Limits now set for this role")[1]).toContain("Time 60 min");
    expect(rows.find((r) => r[0] === "Limits now set for this role")[1]).toContain("Auto resume on");
  });
  it("lists nothing about model or commit when none was recorded", () => {
    const rows = factRows(BARE);
    expect(rows.map((r) => r[0])).toEqual(["Limits now set for this role"]);
  });
  it("links the issue and the PR only when the repo and the numbers are recorded and safe", () => {
    expect(githubLinks(REVIEW)).toEqual([
      { label: "Issue #42", href: "https://github.com/acme/docs/issues/42" },
      { label: "PR #57", href: "https://github.com/acme/docs/pull/57" },
    ]);
    expect(githubLinks(BARE)).toEqual([]);
    expect(githubLinks({ work_item: { repo: { owner: "a/b", name: "docs" }, issue_number: 1 }, pr_number: 2 })).toEqual([]);
    expect(githubLinks({ work_item: { repo: { owner: "acme", name: "docs" }, issue_number: null }, pr_number: 0 })).toEqual([]);
    expect(githubLinks({ work_item: { repo: null, issue_number: 5 }, pr_number: 5 })).toEqual([]);
  });
  it("never links a pull request whose number is the issue's own (an executor's dispatch target is the issue)", () => {
    const item = { repo: { owner: "acme", name: "docs" }, issue_number: 64 };
    expect(githubLinks({ work_item: item, pr_number: 64 })).toEqual([{ label: "Issue #64", href: "https://github.com/acme/docs/issues/64" }]);
    expect(githubLinks({ work_item: item, pr_number: 70 }).map((l) => l.label)).toEqual(["Issue #64", "PR #70"]);
  });
});

describe("failure reason", () => {
  it("says why a run failed in a fixed sentence per known code, and names an unknown code safely", () => {
    expect(failureText({ failure_reason: "sandbox_busy" })).toMatch(/still using this item's sandbox/);
    expect(failureText({ failure_reason: "sandbox_error" })).toMatch(/sandbox could not be created or started/);
    expect(failureText({ failure_reason: "brand_new_code" })).toBe("The run failed (reason code: brand_new_code).");
    expect(failureText({ failure_reason: "<b>x</b>" })).toBe("The run failed (reason code: bxb).");
  });
  it("says nothing for a run that recorded no reason", () => {
    for (const none of [{ failure_reason: null }, {}, { failure_reason: "" }, { failure_reason: 5 }, null, undefined]) expect(failureText(none)).toBeNull();
    expect(failureText(EXEC)).toBeNull();
  });
});

describe("readInsight", () => {
  it("accepts every fixture and keeps what it needs", () => {
    for (const f of [REVIEW, EXEC, BARE]) expect(readInsight(f)).not.toBeNull();
    expect(readInsight(REVIEW).outcome.findings).toHaveLength(2);
    expect(readInsight(BARE).outcome).toBeNull();
  });
  it("refuses a body that is not an insight (the run row the detail loads is not one)", () => {
    for (const bad of [null, undefined, "x", [], {}, { id: "1", role: "build", status: "running" }, { run: { id: "1", role: "x", status: "y" } }, { run: { id: 1 }, lines: [], cost: {} }]) {
      expect(readInsight(bad)).toBeNull();
    }
  });
  it("drops malformed lines, linked runs and findings instead of failing", () => {
    const got = readInsight({
      ...REVIEW,
      lines: [{ at: "2026-10-03T10:00:00.000Z", text: "ok" }, { text: "no time" }, null, 5],
      parent: { id: "bad" },
      children: [{ id: "x" }, EXEC.children[0]],
      outcome: { ...REVIEW.outcome, findings: ["fine", 3, null, { a: 1 }] },
    });
    expect(got.lines).toHaveLength(1);
    expect(got.parent).toBeNull();
    expect(got.children).toHaveLength(1);
    expect(got.outcome.findings).toEqual(["fine"]);
  });
  it("never lets the tool's two-word name through, however it is spelled", () => {
    const got = readInsight({
      ...REVIEW,
      outcome: { ...REVIEW.outcome, summary: "Claude​ Code found it", findings: ["claude_code", "CLAUDE-CODE", "Claude&nbsp;Code"] },
      lines: [{ at: "2026-10-03T10:00:00.000Z", text: "Ran: echo Claude   Code" }],
    });
    const all = JSON.stringify(got);
    expect(all).not.toMatch(/claude[\s_\-. ​]*code/i);
    expect(got.outcome.summary).toBe("Claude found it");
  });
});
