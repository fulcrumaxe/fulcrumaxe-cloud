// apps/workspace/test/runner-events.test.mjs
//
// D#6 R2b-5b: the Runs detail draws a run on the person's own machine: one typed line per runner event, the usage line in
// the cost block, and the Pipeline row's copy of it. The run_ended words are pinned to the runner protocol's copy.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { costRows, runnerEventLine, runnerUsageLine } from "../apps/runs/runs-detail.js";
import { ownPlanText, runnerUsageText } from "../apps/pipeline/pipeline-actions.js";

const usage = (over = {}) => ({ credential_mode: "subscription", model: "claude-sonnet-4-5", tokens_in: 182000, tokens_out: 9400, cache_read_tokens: 5000, cache_write_tokens: 0, api_equivalent_usd: 1.2345, price_table_version: "v1", ...over });
const COST = { model: { usd: null, source: null, tokens_in: null, tokens_out: null }, compute: { usd: null, source: null } };

describe("each runner event type is one typed line", () => {
  it.each([
    [{ type: "tool_use", tool_name: "Edit", file_path: "src/a.ts" }, "Used Edit · src/a.ts"],
    [{ type: "tool_use", tool_name: "Bash" }, "Used Bash"],
    [{ type: "file_changed", file_path: "src/a.ts" }, "Changed src/a.ts"],
    [{ type: "command_exit", exit_code: 1, duration_ms: 2500 }, "Command exited 1 after 2.5s"],
    [{ type: "command_exit", exit_code: 0, duration_ms: 3000 }, "Command exited 0 after 3s"],
    [{ type: "command_exit" }, "Command exited"],
    // The display filter turns the tool's two-word name into "Claude", on every line.
    [{ type: "engine_version", engine_version: "2.1.0" }, "Claude 2.1.0"],
    [{ type: "usage", usage: { input: 1000, output: 200, usd: 0.5 } }, "1,000 in / 200 out tokens"],
    [{ type: "usage", usage: { input: 1000, output: 200 } }, "1,000 in / 200 out tokens"],
    [{ type: "usage_limit_reached", reset_at: "2026-10-09T18:30:00.000Z" }, "Plan usage limit reached; resumes at 2026-10-09 18:30 UTC"],
    [{ type: "usage_limit_reached" }, "Plan usage limit reached"],
    [{ type: "credential_mismatch" }, "The sign-in on your runner is not the one this run was set up with."],
    [{ type: "taken_over" }, "Taken over on the machine"],
  ])("%j", (payload, line) => {
    expect(runnerEventLine(payload)).toBe(line);
  });

  it("the per-event usage line never shows a dollar figure, even when the event carries usd", () => {
    for (const usd of [0.5, 99, 0, 0.0001]) expect(runnerEventLine({ type: "usage", usage: { input: 1, output: 2, cache_read: 3, usd } })).not.toContain("$");
  });

  it("an unknown or missing type is 'Runner step', never the old words", () => {
    for (const p of [{ type: "something_new" }, {}, null, undefined, "x", [], { type: 5 }]) expect(runnerEventLine(p)).toBe("Runner step");
  });

  it("no line, for any input, reads 'runner event'", () => {
    const all = [
      { type: "tool_use" }, { type: "file_changed" }, { type: "command_exit" }, { type: "engine_version" }, { type: "usage" }, { type: "usage_limit_reached" },
      { type: "credential_mismatch" }, { type: "taken_over" }, { type: "run_ended" }, { type: "nope" }, null,
    ];
    for (const p of all) expect(runnerEventLine(p).toLowerCase()).not.toContain("runner event");
  });

  it("the two-word tool name never gets through, in a tool or file name", () => {
    expect(runnerEventLine({ type: "tool_use", tool_name: "Claude_Code", file_path: "notes/claude code.md" })).not.toMatch(/claude[\s_-]*code/i);
    expect(runnerEventLine({ type: "file_changed", file_path: "a/Claude-Code.txt" })).toBe("Changed a/Claude.txt");
  });

  it("markup in a path or tool name stays text (the line is a string that is drawn as a text node)", () => {
    const line = runnerEventLine({ type: "tool_use", tool_name: "x", file_path: "<img src=x onerror=alert(1)>" });
    expect(line).toBe("Used x · <img src=x onerror=alert(1)>");
  });

  it("a non-numeric exit code or duration is left out, not drawn as NaN", () => {
    expect(runnerEventLine({ type: "command_exit", exit_code: "1; rm", duration_ms: "soon" })).toBe("Command exited");
    expect(runnerEventLine({ type: "usage", usage: { input: "many", output: null } })).toBe("0 in / 0 out tokens");
  });
});

// The words are the runner protocol's copy.ts. The workspace does not import that package (a cross-package import would need a declared
// dependency), so each line is pinned by reading the file: every line drawn must be written there, word for word.
const COPY_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "runner-protocol", "src", "copy.ts"), "utf8");
const inCopy = (line) => COPY_SRC.includes(line);
const ended = (e) => runnerEventLine({ type: "run_ended", ...e });
const SETUP_WITH_OWN_LINE = [
  "clone_limited", "push_ref_refused", "snapshot_refused", "push_failed", "mirror_failed", "mirror_dir_insecure",
  "git_version_unsupported", "workspace_failed", "workspace_git_refused", "head_not_from_base", "sandbox_stub_committed",
];
const SETUP_PLAIN = ["sandbox_unavailable", "claude_binary_missing", "claude_version_unsupported", "claude_flags_unsupported", "auth_missing", "bad_start_options", "no_init_line", "permission_mode_forced", "continuation_branch_missing", "model_unsupported", "other"];

describe("run_ended uses the protocol's copy.ts words", () => {
  it("job_refused, agent_failed and push_rejected", () => {
    expect(ended({ reason: "job_refused", detail: "unknown_role" })).toBe("Your runner refused this job (unknown_role). Update the runner, then retry.");
    expect(inCopy("Your runner refused this job ({detail}). Update the runner, then retry.")).toBe(true);
    expect(inCopy(ended({ reason: "agent_failed" }))).toBe(true);
    expect(inCopy(ended({ reason: "push_rejected" }))).toBe(true);
    expect(ended({ reason: "job_refused" })).toContain("(other)");
  });
  it("every runner_setup detail with a line of its own draws that line, written in copy.ts", () => {
    for (const detail of SETUP_WITH_OWN_LINE) {
      const line = ended({ reason: "runner_setup", detail });
      expect(inCopy(line), detail).toBe(true);
    }
    expect(new Set(SETUP_WITH_OWN_LINE.map((detail) => ended({ reason: "runner_setup", detail }))).size).toBe(SETUP_WITH_OWN_LINE.length);
  });
  it("the other runner_setup details use the plain-code sentence, as the protocol does", () => {
    expect(inCopy("Your runner could not start the agent ({detail}). Check the runner's setup, then retry.")).toBe(true);
    for (const detail of SETUP_PLAIN) expect(ended({ reason: "runner_setup", detail })).toBe("Your runner could not start the agent (" + detail + "). Check the runner's setup, then retry.");
    expect(ended({ reason: "runner_setup" })).toBe("Your runner could not start the agent (other). Check the runner's setup, then retry.");
  });
  it("push_too_large fills in the size, and without a usable size falls back to the plain code", () => {
    expect(ended({ reason: "runner_setup", detail: "push_too_large", size_mb: 12 })).toBe("This push is 12 MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).");
    expect(inCopy("This push is {size} MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).")).toBe(true);
    for (const size_mb of [undefined, 4, 1.5, "9"]) expect(ended({ reason: "runner_setup", detail: "push_too_large", size_mb })).toContain("(push_too_large)");
  });
  it("a reason with no copy.ts line is shown as words, and none leaves a hole", () => {
    expect(ended({ reason: "wall_clock" })).toBe("The run ended (wall clock)");
    expect(ended({ reason: "runner_shutdown" })).toBe("The run ended (runner shutdown)");
    expect(ended({ reason: "repo_not_private" })).toBe("The run ended (repo not private)");
    expect(ended({})).toBe("The run ended");
    for (const reason of ["job_refused", "repo_not_private", "agent_failed", "wall_clock", "runner_setup", "runner_shutdown", "push_rejected", "from_the_future"]) expect(ended({ reason })).not.toMatch(/undefined|null|\{/);
  });
  it("an odd reason or detail is not drawn as given", () => {
    expect(ended({ reason: "<b>x</b>", detail: "<i>" })).toBe("The run ended");
    expect(ended({ reason: "job_refused", detail: "<i>" })).toContain("(other)");
  });
});

describe("cost block for a run on the person's machine", () => {
  const rows = (u, status = "succeeded") => costRows(COST, status, u);
  it("priced, on a Claude plan", () => {
    const [model, compute] = rows(usage());
    expect(model.value).toBe("On your Claude plan · API-equivalent $1.23 · 182,000 in / 9,400 out tokens");
    expect(model.bill).toBeNull();
    expect(compute.value).toBe("Ran on your machine: no sandbox compute");
  });
  it("unpriced", () => {
    expect(rows(usage({ api_equivalent_usd: null }))[0].value).toBe("On your Claude plan · no API price for this model · 182,000 in / 9,400 out tokens");
  });
  it("API-key mode, priced and unpriced", () => {
    expect(rows(usage({ credential_mode: "api_key" }))[0].value).toBe("On your own API key · $1.23 at API prices · 182,000 in / 9,400 out tokens");
    expect(rows(usage({ credential_mode: "api_key", api_equivalent_usd: null }))[0].value).toBe("On your own API key · no API price for this model · 182,000 in / 9,400 out tokens");
  });
  it("a small figure keeps four places, zero stays $0.00", () => {
    expect(runnerUsageLine(usage({ api_equivalent_usd: 0.0042 }))).toContain("API-equivalent $0.0042");
    expect(runnerUsageLine(usage({ api_equivalent_usd: 0 }))).toContain("API-equivalent $0.00");
  });
  it("no usage yet: counting while live, not recorded after", () => {
    expect(rows(null, "running")[0].value).toBe("Counting…");
    expect(rows(null)[0].value).toBe("Not recorded");
    expect(rows(null)[0].detail).toBeNull();
  });
  it("is never called spend, a charge, fulfilment or cost of fulcrumaxe", () => {
    for (const u of [usage(), usage({ credential_mode: "api_key" }), usage({ api_equivalent_usd: null }), null]) {
      const text = JSON.stringify(rows(u)).toLowerCase();
      expect(text).not.toMatch(/spend|spent|charge|fulfil|billed|fulcrumaxe/);
    }
  });
  it("a sandbox run (no usage argument) is byte-identical to before", () => {
    const sandbox = { model: { usd: 1.23, source: "customer_anthropic", tokens_in: 182000, tokens_out: 9400 }, compute: { usd: 0.04, source: "sandbox" } };
    expect(JSON.stringify(costRows(sandbox, "succeeded"))).toBe(
      JSON.stringify([
        { key: "model", label: "Model usage", value: "$1.23", bill: "On your Anthropic key", detail: "182,000 in, 9,400 out" },
        { key: "compute", label: "Sandbox compute", value: "$0.04", bill: "Sandbox compute, billed to the workspace", detail: null },
      ])
    );
    expect(JSON.stringify(costRows(sandbox, "succeeded", undefined))).toBe(JSON.stringify(costRows(sandbox, "succeeded")));
  });
});

describe("the Pipeline run row says the same thing", () => {
  it("matches the Runs detail for every state, and says nothing for a sandbox run or a run with no usage yet", () => {
    for (const u of [usage(), usage({ api_equivalent_usd: null }), usage({ credential_mode: "api_key" }), usage({ credential_mode: "api_key", api_equivalent_usd: null }), usage({ api_equivalent_usd: 0.0042 })]) {
      expect(runnerUsageText({ runtime: "runner", runner_usage: u })).toBe(runnerUsageLine(u));
    }
    expect(runnerUsageText({ runtime: "sandbox" })).toBeNull();
    expect(runnerUsageText({ runtime: "runner", runner_usage: null })).toBeNull();
    expect(runnerUsageText({ runtime: "runner" })).toBeNull();
    expect(runnerUsageText(null)).toBeNull();
  });
  it("the item's own-plan total shows only when there is one", () => {
    expect(ownPlanText(2.5)).toBe("On your own plan (API-equivalent): $2.50");
    for (const none of [0, null, undefined, NaN, "3"]) expect(ownPlanText(none)).toBeNull();
  });
});
