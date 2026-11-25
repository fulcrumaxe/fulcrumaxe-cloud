// apps/workspace/test/repos-remove.test.mjs
//
// D#845 ON-16a2: the Remove from fulcrumaxe sheet, state by state. The decisions are in the helpers and the controller (no DOM); the DOM
// (the dialog, <bdi>, the row line, focus) is driven in the browser by e2e/repos-remove.spec.ts. The vitest environment is node.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TICKS, PR_CODE_SENTENCES, PR_NOTHING, PR_OTHER, REFUSALS, STATES, createRemoveFlow, githubUrl, prLine, readAnswer, refusalSentence, removalText, removalView, removeUrl,
} from "../apps/repos/repos-runners.js";

const FX = JSON.parse(readFileSync(new URL("../e2e/repos-removal-fixture.json", import.meta.url), "utf8"));
const WEB = FX.repos.none;
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });

function fakeCall(reply) {
  const log = [];
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const v = typeof reply === "function" ? reply(body) : reply;
    if (v instanceof Error) throw v;
    return v;
  });
  call.log = log;
  return call;
}

describe("the default ticks", () => {
  it("delete the sandbox, no removal PR, and the fixture says the same", () => {
    expect(DEFAULT_TICKS).toEqual({ deleteSandbox: true, removalPr: false });
    expect(FX.ticks).toEqual({ delete_sandbox: DEFAULT_TICKS.deleteSandbox, removal_pr: DEFAULT_TICKS.removalPr });
  });
  it("a fresh sheet opens with them, sends nothing, and keeps them on the 'ask' phase", () => {
    const call = fakeCall(FX.answers.queued_no_pr);
    const flow = createRemoveFlow({ call });
    flow.begin(WEB);
    expect(flow.state).toMatchObject({ phase: "ask", deleteSandbox: true, removalPr: false, repoId: WEB.id, name: "acme/widgets" });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("the removal states of a row (item 5 copy)", () => {
  const text = (name) => removalText(removalView(FX.repos[name].removal));
  it("waiting_machine reads 'Waiting for <machine> to come back'", () => expect(text("waiting_machine")).toBe("Waiting for Studio box שלום to come back"));
  it("removing reads 'Removing from <machine>…'", () => expect(text("removing")).toBe("Removing from Studio box…"));
  it("failed names the code and the two ways out", () =>
    expect(text("failed")).toBe("Couldn't remove the engine's sandbox from Studio box (sandbox_busy). Remove the machine to clear it, or place the project on another machine."));
  it("no removal, and a state this file does not know, show no line", () => {
    expect(removalView(null)).toBeNull();
    expect(removalView(undefined)).toBeNull();
    expect(removalView({ state: "done", machine_name: "x", failure_code: null })).toBeNull();
    expect(removalView("waiting_machine")).toBeNull();
  });
  it("the three states are exactly the three the read can carry", () => expect(STATES).toEqual(["waiting_machine", "removing", "failed"]));
  it("a missing machine name or code never prints null or undefined", () => {
    expect(removalText(removalView({ state: "waiting_machine", machine_name: "", failure_code: null }))).toBe("Waiting for its machine to come back");
    const failed = removalText(removalView({ state: "failed", machine_name: "M", failure_code: null }));
    expect(failed).toBe("Couldn't remove the engine's sandbox from M. Remove the machine to clear it, or place the project on another machine.");
    for (const t of [failed, text("waiting_machine"), text("removing")]) expect(t).not.toMatch(/null|undefined/);
  });
});

describe("the PR line", () => {
  it("'Opened PR #<n>' with its GitHub link", () => expect(prLine(FX.answers.pr_opened.pr)).toEqual({ text: "Opened PR #41", number: 41, url: "https://github.com/acme/widgets/pull/41" }));
  it("a PR that already exists reads the same, a link that is not GitHub is dropped", () => {
    expect(prLine({ outcome: "exists", number: 7, branch: "b", url: "https://github.com/a/b/pull/7" })).toMatchObject({ text: "Opened PR #7", url: "https://github.com/a/b/pull/7" });
    expect(prLine({ outcome: "opened", number: 7, branch: "b", url: "https://evil.example/a/b/pull/7" })).toEqual({ text: "Opened PR #7", number: 7, url: "" });
    expect(githubUrl("javascript:alert(1)")).toBe("");
    expect(githubUrl("http://github.com/a")).toBe("");
  });
  it("each ON-16b code has its own sentence, and an unknown code the generic one", () => {
    for (const code of ["install_pr_not_merged", "tree_truncated", "removal_branch_conflict", "github_unavailable"]) {
      expect(prLine({ code })).toEqual({ text: PR_CODE_SENTENCES[code], number: null, url: "" });
      expect(PR_CODE_SENTENCES[code]).not.toMatch(/_|undefined|null/);
    }
    expect(prLine({ code: "brand_new" }).text).toBe(PR_OTHER);
  });
  it("nothing to remove has its sentence, no PR asked for has no line, and a malformed one is the generic line", () => {
    expect(prLine({ outcome: "nothing_to_remove", number: null, branch: "b", url: null }).text).toBe(PR_NOTHING);
    expect(prLine(null)).toBeNull();
    expect(prLine(undefined)).toBeNull();
    expect(prLine({ outcome: "opened", number: 0, url: null }).text).toBe(PR_OTHER);
    expect(prLine("x").text).toBe(PR_OTHER);
  });
});

describe("the removal request", () => {
  it("sends nothing until confirm, then exactly one POST with the two ticks", async () => {
    const call = fakeCall(FX.answers.queued_no_pr);
    const flow = createRemoveFlow({ call });
    flow.begin(WEB);
    flow.toggle("removalPr", true);
    flow.toggle("deleteSandbox", false);
    expect(call).not.toHaveBeenCalled();
    await flow.confirm();
    expect(call.log).toEqual([["POST", removeUrl(WEB.id), { delete_sandbox: false, removal_pr: true }]]);
    expect(Object.keys(call.log[0][2]).sort()).toEqual(["delete_sandbox", "removal_pr"]);
  });
  it("the default ticks send delete_sandbox true and removal_pr false", async () => {
    const call = fakeCall(FX.answers.queued_no_pr);
    const flow = createRemoveFlow({ call });
    flow.begin(WEB);
    await flow.confirm();
    expect(call.log[0][2]).toEqual({ delete_sandbox: true, removal_pr: false });
    expect(removeUrl("a b")).toBe("/api/runners/repos/a%20b/remove");
  });
  it("a double press is one request, and a finished sheet cannot send again", async () => {
    let release;
    const call = vi.fn(() => new Promise((r) => (release = () => r(FX.answers.queued_no_pr))));
    const onDone = vi.fn();
    const flow = createRemoveFlow({ call, onDone });
    flow.begin(WEB);
    const first = flow.confirm();
    flow.confirm();
    flow.toggle("removalPr", true); // ticks are locked while sending
    flow.cancel(); // and so is cancel
    expect(flow.state.phase).toBe("sending");
    release();
    await first;
    await flow.confirm();
    expect(call).toHaveBeenCalledTimes(1);
    expect(flow.state.phase).toBe("done");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it("the answer is kept: queued machine parts, the PR line, and 'already removed'", async () => {
    for (const [name, queued, already, pr] of [["queued_no_pr", true, false, null], ["none_no_pr", false, true, null], ["pr_opened", true, false, "Opened PR #41"], ["pr_code", true, false, PR_CODE_SENTENCES.install_pr_not_merged]]) {
      const flow = createRemoveFlow({ call: fakeCall(FX.answers[name]) });
      flow.begin(WEB);
      await flow.confirm();
      expect(flow.state.phase, name).toBe("done");
      expect(flow.state.answer.queued, name).toBe(queued);
      expect(flow.state.answer.already, name).toBe(already);
      expect(flow.state.answer.pr ? flow.state.answer.pr.text : null, name).toBe(pr);
    }
  });
  it("an answer of an unknown shape is the generic refusal, and the list is still re-read", async () => {
    const onDone = vi.fn();
    const flow = createRemoveFlow({ call: fakeCall({ machine_parts: "maybe" }), onDone });
    flow.begin(WEB);
    await flow.confirm();
    expect(flow.state).toMatchObject({ phase: "error", error: REFUSALS.other });
    expect(readAnswer(null)).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it("a refusal is a sentence of this file's own, never the server's text, and the person can try again", async () => {
    const cases = [[403, "forbidden", REFUSALS.forbidden], [403, "insufficient_role", REFUSALS.forbidden], [404, "not_found", REFUSALS.not_found], [409, "setup_running", REFUSALS.setup_running], [409, "placement_busy", REFUSALS.placement_busy], [400, "invalid_message", REFUSALS.invalid_message], [500, "internal", REFUSALS.other], [0, "offline", REFUSALS.other]];
    for (const [status, code, words] of cases) {
      const onDone = vi.fn();
      const flow = createRemoveFlow({ call: fakeCall(fail(status, code)), onDone });
      flow.begin(WEB);
      await flow.confirm();
      expect(flow.state, code).toMatchObject({ phase: "error", error: words });
      expect(flow.state.error).not.toContain("server text");
      expect(onDone).toHaveBeenCalledTimes(status === 404 ? 1 : 0);
      flow.toggle("removalPr", true); // editing after an error returns to 'ask'
      expect(flow.state).toMatchObject({ phase: "ask", error: "" });
    }
    expect(refusalSentence(undefined)).toBe(REFUSALS.other);
  });
  it("a cancelled request (the window closed) leaves the sheet as it was", async () => {
    const flow = createRemoveFlow({ call: fakeCall(Object.assign(new Error("x"), { name: "AbortError" })) });
    flow.begin(WEB);
    await flow.confirm();
    expect(flow.state.phase).toBe("sending");
  });
  it("cancel closes the sheet without a request, and begin again starts from the default ticks", () => {
    const call = fakeCall(FX.answers.queued_no_pr);
    const flow = createRemoveFlow({ call });
    flow.begin(WEB);
    flow.toggle("deleteSandbox", false);
    flow.cancel();
    expect(flow.state).toBeNull();
    flow.begin(WEB);
    expect(flow.state).toMatchObject({ deleteSandbox: true, removalPr: false });
    expect(call).not.toHaveBeenCalled();
    flow.toggle("nonsense", true);
    expect(flow.state).not.toHaveProperty("nonsense");
  });
  it("a repo with no GitHub name is shown by its product name", () => {
    const flow = createRemoveFlow({ call: fakeCall({}) });
    flow.begin({ id: "x", product: "web", full_name: null });
    expect(flow.state.name).toBe("web");
  });
});
