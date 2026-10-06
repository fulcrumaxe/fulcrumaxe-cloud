// apps/workspace/test/pipeline-operator.test.mjs
//
// D#483: the buttons for a stuck item (Build again, Back to discussion, Treat as a feature, Close). The logic
// (createOperator) against a fake call(), and the small pure helpers. The view is covered by the Playwright spec
// (e2e/pipeline-operator.spec.ts), which needs a real DOM and a real <dialog>.
// The rules under test: the app keeps NO rule of its own (a button is drawn only for an action the server listed), no
// request carries a body, each outcome is a fixed sentence (never a server code or message), one click is one request, Close
// asks first, and a refusal is shown, not swallowed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  APPROVE_SENTENCES,
  CLOSE_DIALOG,
  CLOSE_ON_GITHUB_NOTE,
  OPERATOR_LABELS,
  OPERATOR_NOTES,
  OPERATOR_ORDER,
  OPERATOR_PATHS,
  OPERATOR_STARTED,
  SENDING,
  approvePath,
  approveSentenceFor,
  closeOnHost,
  createOperator,
  operatorActions,
} from "../apps/pipeline/pipeline-actions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ITEM = { id: ID, stage: "needs_human", provenance: "internal", repo_id: OTHER, issue_number: 7, kind: "feature" };
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const flush = () => new Promise((r) => setTimeout(r, 0));

/** `reply` answers the POST (a value, a function or an Error); `action` answers every GET of the run action. */
function fakeCall(reply = { action_id: "a1", state: "accepted" }, action = { state: "done" }) {
  const log = [];
  const call = vi.fn(async (...args) => {
    log.push(args);
    if (args[0] === "GET") {
      if (action instanceof Error) throw action;
      return action;
    }
    const r = typeof reply === "function" ? reply() : reply;
    if (r instanceof Error) throw r;
    return r;
  });
  call.log = log;
  return call;
}
const posts = (call) => call.log.filter((a) => a[0] === "POST");
const gets = (call) => call.log.filter((a) => a[0] === "GET");
const make = (call, extra = {}) => {
  const changes = [];
  const done = [];
  const op = createOperator({ call, sleep: async () => {}, onChange: () => changes.push(1), onDone: (...a) => done.push(a), ...extra });
  return { op, changes, done };
};

describe("one rule source: the app draws what the server lists, in a fixed order, and nothing else", () => {
  it("the action ids and their order are the server's (read from @fx/core's table, so a drift fails here)", () => {
    const core = readFileSync(join(HERE, "..", "..", "..", "packages", "core", "src", "work-items", "operatorActions.ts"), "utf8");
    const m = /OPERATOR_ACTIONS = \[([^\]]*)\] as const/.exec(core);
    expect([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual(OPERATOR_ORDER);
    expect(Object.keys(OPERATOR_LABELS)).toEqual(OPERATOR_ORDER);
    expect(Object.keys(OPERATOR_NOTES)).toEqual(OPERATOR_ORDER);
    expect(Object.keys(OPERATOR_PATHS)).toEqual(OPERATOR_ORDER);
    expect(Object.keys(OPERATOR_STARTED)).toEqual(OPERATOR_ORDER);
  });

  it("the labels are exactly the words the owner approved", () => {
    expect(OPERATOR_LABELS).toEqual({ build_again: "Build again", back_to_discussion: "Back to discussion", treat_as_feature: "Treat as a feature", close: "Close", reopen: "Reopen" });
  });

  it("operatorActions keeps the listed actions it knows, in the fixed order; anything else is ignored", () => {
    expect(operatorActions({ actions: ["close", "build_again", "back_to_discussion"] })).toEqual(["build_again", "back_to_discussion", "close"]);
    expect(operatorActions({ actions: ["treat_as_feature", "close"] })).toEqual(["treat_as_feature", "close"]);
    expect(operatorActions({ actions: ["delete_everything", "close", "__proto__", 7, null] })).toEqual(["close"]);
    for (const bad of [null, undefined, {}, { actions: "close" }, { actions: null }, "close", 7]) expect(operatorActions(bad), String(bad)).toEqual([]);
  });

  it("the stage and the kind of the item play no part: nothing is drawn unless the server listed it", () => {
    // Even a stuck-looking item gets no button from the app's own guess; the list is the only input.
    expect(operatorActions({ stage: "needs_human", kind: "feature", provenance: "internal" })).toEqual([]);
    expect(operatorActions({ stage: "discussing", kind: "project", actions: [] })).toEqual([]);
  });

  it("Close is replaced by a pointer to the pull request only when the server says so (the JSON true, nothing truthy)", () => {
    expect(closeOnHost({ close_on_github: true })).toBe(true);
    for (const v of [false, "true", 1, null, undefined]) expect(closeOnHost({ close_on_github: v }), String(v)).toBe(false);
    expect(closeOnHost(null)).toBe(false);
    expect(CLOSE_ON_GITHUB_NOTE).toMatch(/close its pull request on GitHub/);
  });

  it("the paths: Build again is the approve route; the other three are routes of their own, ids encoded", () => {
    expect(OPERATOR_PATHS.build_again(ID)).toBe(approvePath(ID));
    expect(OPERATOR_PATHS.back_to_discussion(ID)).toBe("/api/v1/work-items/" + ID + "/back-to-discussion");
    expect(OPERATOR_PATHS.treat_as_feature(ID)).toBe("/api/v1/work-items/" + ID + "/treat-as-feature");
    expect(OPERATOR_PATHS.close(ID)).toBe("/api/v1/work-items/" + ID + "/close");
    expect(OPERATOR_PATHS.close("a/b?c")).toBe("/api/v1/work-items/a%2Fb%3Fc/close");
  });
});

describe("createOperator: the three actions that start the pipeline", () => {
  it.each([
    ["build_again", approvePath(ID)],
    ["back_to_discussion", "/api/v1/work-items/" + ID + "/back-to-discussion"],
    ["treat_as_feature", "/api/v1/work-items/" + ID + "/treat-as-feature"],
  ])("%s: one POST with NO body, the accepted request is followed, the sentence is the fixed one, and the card is told", async (action, path) => {
    const call = fakeCall();
    const { op, done } = make(call);
    await op.press(ITEM, action);
    expect(posts(call)).toHaveLength(1);
    expect(posts(call)[0]).toEqual(["POST", path, undefined]); // the third argument is undefined: no JSON at all
    expect(gets(call).map((g) => g[1])).toEqual(["/api/v1/run-actions/a1"]);
    expect(op.state).toMatchObject({ itemId: ID, phase: "started", action, text: OPERATOR_STARTED[action], confirm: false });
    expect(done).toEqual([[ID, action]]);
  });

  it("while the request is out the state says Sending…", async () => {
    let release;
    const call = vi.fn((m) => (m === "POST" ? new Promise((r) => (release = r)) : Promise.resolve({ state: "done" })));
    const { op } = make(call);
    const p = op.press(ITEM, "build_again");
    expect(op.state).toMatchObject({ phase: "sending", text: SENDING });
    release({ action_id: "a1" });
    await p;
    expect(op.state.phase).toBe("started");
  });

  it("one click is one request: a second press while sending, and after it started, sends nothing", async () => {
    const call = fakeCall();
    const { op } = make(call);
    const first = op.press(ITEM, "build_again");
    await op.press(ITEM, "back_to_discussion");
    await first;
    await op.press(ITEM, "build_again");
    expect(posts(call)).toHaveLength(1);
    op.reset(ITEM.id); // opening the card again starts fresh
    await op.press(ITEM, "build_again");
    expect(posts(call)).toHaveLength(2);
  });

  it("an unknown action is never sent", async () => {
    const call = fakeCall();
    const { op } = make(call);
    for (const a of ["delete", "approve", "__proto__", "", undefined]) await op.press(ITEM, a);
    await op.press(null, "build_again");
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["the server refuses with 409 action_not_available", fail(409, "action_not_available"), "action_not_available"],
    ["agents are already working on it", fail(409, "already_running"), "already_running"],
    ["not an owner or admin", fail(403, "insufficient_role"), "insufficient_role"],
    ["an external item", fail(403, "external_requires_human"), "external_requires_human"],
    ["no repository", fail(409, "no_repo"), "no_repo"],
    ["the pipeline is unavailable", fail(503, "run_actions_unavailable"), "run_actions_unavailable"],
    ["the network is down", fail(0, "network"), "network"],
    ["an unknown code", fail(500, "something_new"), "generic"],
  ])("a refusal (%s) is a fixed sentence, never the server's text", async (_n, error, key) => {
    const { op } = make(fakeCall(error));
    await op.press(ITEM, "build_again");
    const expected = key === "generic" ? approveSentenceFor("zzz") : APPROVE_SENTENCES[key];
    expect(op.state).toMatchObject({ phase: "error", text: expected });
    expect(op.state.text).not.toContain("server text");
    expect(op.state.text).toBe(approveSentenceFor(error.code));
  });

  it("a 429 reads as 'too fast', whatever code came with it", async () => {
    const { op } = make(fakeCall(fail(429, "rate_limited")));
    await op.press(ITEM, "back_to_discussion");
    expect(op.state.text).toBe(APPROVE_SENTENCES.rate_limited);
  });

  it("a refusal the worker gives after accepting (no model key) reaches the sentence; the card is not told", async () => {
    const { op, done } = make(fakeCall({ action_id: "a1" }, { state: "refused", error_code: "no_model" }));
    await op.press(ITEM, "build_again");
    expect(op.state).toMatchObject({ phase: "error", text: APPROVE_SENTENCES.no_model });
    expect(done).toEqual([]);
  });

  it("a failed read of the request is not a refusal: the pipeline has started", async () => {
    const { op } = make(fakeCall({ action_id: "a1" }, fail(0, "network")));
    await op.press(ITEM, "treat_as_feature");
    expect(op.state.phase).toBe("started");
  });

  it("a card that was closed or changed while the request was out is not overwritten", async () => {
    let release;
    const call = vi.fn((m) => (m === "POST" ? new Promise((r) => (release = r)) : Promise.resolve({ state: "done" })));
    const { op, done } = make(call);
    const p = op.press(ITEM, "build_again");
    op.reset(OTHER);
    release({ action_id: "a1" });
    await p;
    expect(op.state).toMatchObject({ itemId: OTHER, phase: "idle", text: "" });
    expect(done).toEqual([]);
  });

  it("an aborted request says nothing", async () => {
    const { op } = make(fakeCall(Object.assign(new Error("x"), { name: "AbortError" })));
    await op.press(ITEM, "build_again");
    expect(op.state.phase).toBe("sending");
  });
});

describe("createOperator: Close asks first, in the app's own dialog", () => {
  it("pressing Close sends nothing: it opens the confirm", async () => {
    const call = fakeCall();
    const { op } = make(call);
    await op.press(ITEM, "close");
    expect(call).not.toHaveBeenCalled();
    expect(op.state).toMatchObject({ itemId: ID, action: "close", confirm: true });
  });

  it("Keep it open (or Escape, or a click outside) closes the confirm and sends nothing", async () => {
    const call = fakeCall();
    const { op } = make(call);
    await op.press(ITEM, "close");
    op.dismiss();
    expect(op.state.confirm).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("Yes, close it: one POST to /close with no body, no polling, 'Closed.', and the card is told", async () => {
    const call = fakeCall({ work_item_id: ID, stage: "closed" });
    const { op, done } = make(call);
    await op.press(ITEM, "close");
    await op.confirmClose(ITEM);
    expect(posts(call)).toEqual([["POST", "/api/v1/work-items/" + ID + "/close", undefined]]);
    expect(gets(call)).toEqual([]);
    expect(op.state).toMatchObject({ phase: "started", text: "Closed.", confirm: false });
    expect(done).toEqual([[ID, "close"]]);
  });

  it("confirming without having been asked sends nothing", async () => {
    const call = fakeCall();
    const { op } = make(call);
    await op.confirmClose(ITEM);
    expect(call).not.toHaveBeenCalled();
  });

  it("a refusal keeps the dialog open with the sentence; Keep it open then closes it and clears the sentence", async () => {
    const { op, done } = make(fakeCall(fail(409, "action_not_available")));
    await op.press(ITEM, "close");
    await op.confirmClose(ITEM);
    expect(op.state).toMatchObject({ phase: "error", confirm: true, text: APPROVE_SENTENCES.action_not_available });
    expect(done).toEqual([]);
    op.dismiss();
    expect(op.state).toMatchObject({ confirm: false, phase: "idle", text: "" });
  });

  it("the dialog cannot be dismissed, or confirmed twice, while the request is out", async () => {
    let release;
    const call = vi.fn(() => new Promise((r) => (release = r)));
    const { op } = make(call);
    await op.press(ITEM, "close");
    const p = op.confirmClose(ITEM);
    op.dismiss();
    expect(op.state.confirm).toBe(true);
    await op.confirmClose(ITEM);
    release({ work_item_id: ID, stage: "closed" });
    await p;
    expect(call).toHaveBeenCalledTimes(1);
    expect(op.state.confirm).toBe(false);
  });

  it("the dialog's words are the app's own: a question, what happens, and two buttons that say what they do", () => {
    expect(CLOSE_DIALOG.title).toBe("Close this work item?");
    expect(CLOSE_DIALOG.confirm).toBe("Yes, close it");
    expect(CLOSE_DIALOG.dismiss).toBe("Keep it open");
    expect(CLOSE_DIALOG.lines.join(" ")).toMatch(/no agent will work on it/);
  });

  it("the app never calls the browser's own confirm()", () => {
    const src = readFileSync(join(HERE, "..", "apps", "pipeline", "pipeline-actions.js"), "utf8");
    // The Runs section above has its own confirm() method (a function of the app's own); the browser's is a bare call.
    const code = src.slice(src.indexOf("// --- Stuck items")).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.includes("/**")).join("\n");
    expect(code).not.toMatch(/(^|[^.\w])confirm\(/m);
    expect(code).not.toMatch(/window\.confirm|globalThis\.confirm/);
  });
});

describe("the bytes: no rule of the server is copied into the app", () => {
  const src = readFileSync(join(HERE, "..", "apps", "pipeline", "pipeline-actions.js"), "utf8");
  const section = src.slice(src.indexOf("// --- Stuck items"));

  it("the stuck-item section never looks at a stage, a kind, a provenance or a role", () => {
    // The comment block names stages when it explains; the code below it must not (no quoted stage word, no item.stage, no role).
    const code = section.split("\n").filter((l) => !l.trim().startsWith("//") && !l.includes("/**") && !l.trim().startsWith("*")).join("\n");
    for (const stage of ["triaged", "discussing", "spec_ready", "in_progress", "pr_opened", "changes_requested", "review_passed", "needs_human", "merged", "closed_unmerged"]) {
      expect(code.includes('"' + stage + '"') || code.includes("'" + stage + "'"), stage).toBe(false);
    }
    for (const word of ["item.stage", "item.kind", "provenance", ".role", "insufficient_role"]) expect(code.includes(word), word).toBe(false);
  });
});

describe("the whole stack of words", () => {
  it("every sentence is plain text with no markup", () => {
    for (const t of [...Object.values(OPERATOR_NOTES), ...Object.values(OPERATOR_STARTED), CLOSE_ON_GITHUB_NOTE, ...CLOSE_DIALOG.lines]) expect(t, t).not.toMatch(/[<>]|undefined|null/);
  });
  it("flush helper is not needed: the logic awaits its own requests", async () => {
    await flush();
    expect(true).toBe(true);
  });
});
