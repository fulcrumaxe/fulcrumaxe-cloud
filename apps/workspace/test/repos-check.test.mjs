// apps/workspace/test/repos-check.test.mjs
//
// D#6 R-CHK-3c: the Repos app's check command form, state by state. The decisions are in checkModel and checkBody (no DOM); the wiring is
// exercised in the browser by e2e/repos-check.spec.ts. The view shapes are the ones runner-cloud's GET/PUT sandbox-allowances answer.

import { describe, expect, it } from "vitest";
import { keepFocus, COPY, SOURCE_LINE, SPACE, checkBody, checkModel, draftProblem, showArg } from "../apps/repos/repos-allowances.js";

const NAME = "acme/widgets";
const CHECK = { argv: ["bash", "scripts/check.sh"], dev_shell: true, timeout_s: 5400 };
const A = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install packages" };
const view = (over = {}) => ({
  repo_id: "r", execution_mode: "runner_local", in_use: true, set_aside: false, can_change: true,
  approved: { version: 1, entries: [], check: null, set_sha256: "ab".repeat(32), approved_at: "2026-10-09T00:00:00.000Z" },
  limits: { max_entries: 64, max_command_timeout_s: 1800, max_check_timeout_s: 10800 }, suggested_check: { status: "none" }, ...over,
});
const withCheck = (over = {}) => view({ approved: { version: 2, entries: [A], command_timeout_s: 600, check: CHECK, set_sha256: "cd".repeat(32), approved_at: "2026-10-09T00:00:00.000Z" }, ...over });
const model = (v, o = {}) => checkModel({ view: v, draft: null, typed: "", repoName: NAME, phase: "idle", runnerOutdated: false, ...o });
const draft = (over = {}) => ({ ...CHECK, argv: [...CHECK.argv], source: "suggested", ...over });

describe("per-state copy and kind", () => {
  it("none: nothing approved and nothing suggested", () => {
    for (const v of [view(), view({ approved: null })]) {
      const m = model(v);
      expect(m.kind).toBe("none");
      expect(m.approved).toBeNull();
      expect(m.suggested).toBeNull();
    }
    expect(COPY.none).toBe("No check is approved. A runner won't run a check after the agent.");
  });
  it("suggested: a readable suggestion is offered, never approved", () => {
    const m = model(view({ suggested_check: { status: "ok", check: CHECK } }));
    expect(m.kind).toBe("suggested");
    expect(m.suggested).toEqual(CHECK);
    expect(m.approveDisabled).toBe(true); // no draft, so nothing to approve until the person opens it for review
    expect(SOURCE_LINE).toContain("default branch tip, which an agent can edit");
  });
  it("a suggestion that cannot be read or fetched says so in this file's words and offers nothing", () => {
    const bad = model(view({ suggested_check: { status: "unreadable", message: "SERVER TEXT" } }));
    expect(bad.kind).toBe("none");
    expect(bad.note).toBe(COPY.unreadable);
    expect(model(view({ suggested_check: { status: "unavailable" } })).note).toBe(COPY.unavailable);
    expect(JSON.stringify(bad)).not.toContain("SERVER TEXT");
  });
  it("approved: the check is shown, and a suggestion no longer is", () => {
    const m = model(withCheck({ suggested_check: { status: "ok", check: { ...CHECK, argv: ["other"] } } }));
    expect(m.kind).toBe("approved");
    expect(m.approved).toEqual(CHECK);
    expect(m.suggested).toBeNull();
    expect(m.runnerOld).toBe(false);
  });
  it("set aside: still shown, marked as not in force", () => {
    expect(model(withCheck({ set_aside: true, in_use: false })).kind).toBe("set_aside");
  });
  it("runner too old: only while an approved check is in force and every covering runner is outdated", () => {
    expect(model(withCheck(), { runnerOutdated: true }).runnerOld).toBe(true);
    expect(model(withCheck({ set_aside: true }), { runnerOutdated: true }).runnerOld).toBe(false);
    expect(model(view(), { runnerOutdated: true }).runnerOld).toBe(false);
    expect(COPY.runnerOld).toBe("Update your runner to run this repository's check.");
  });
});

describe("who may approve, and when", () => {
  it("a member sees the check read-only and gets no suggestion to act on", () => {
    const m = model(withCheck({ can_change: false, suggested_check: null }), { draft: draft(), typed: NAME });
    expect(m.canChange).toBe(false);
    expect(m.approveDisabled).toBe(true);
  });
  it("approve needs a draft, a valid one, the repo's name typed exactly, a repo on a runner and a real change", () => {
    const v = view({ suggested_check: { status: "ok", check: CHECK } });
    expect(model(v, { draft: draft(), typed: NAME }).approveDisabled).toBe(false);
    for (const typed of ["", "acme", "ACME/WIDGETS", "acme/widgets ", " acme/widgets"]) expect(model(v, { draft: draft(), typed }).approveDisabled).toBe(true);
    expect(model(v, { draft: draft(), typed: NAME, repoName: "" }).approveDisabled).toBe(true);
    expect(model(v, { draft: draft(), typed: NAME, phase: "saving" }).approveDisabled).toBe(true);
    expect(model(view({ execution_mode: "cloud" }), { draft: draft(), typed: NAME }).approveDisabled).toBe(true);
    expect(model(v, { draft: draft({ argv: [] }), typed: NAME }).approveDisabled).toBe(true);
  });
  it("an edit equal to the approved check is no change, unless the approval is set aside", () => {
    expect(model(withCheck(), { draft: draft(), typed: NAME }).approveDisabled).toBe(true);
    expect(model(withCheck(), { draft: draft({ timeout_s: 6000 }), typed: NAME }).approveDisabled).toBe(false);
    expect(model(withCheck({ set_aside: true }), { draft: draft(), typed: NAME }).approveDisabled).toBe(false);
  });
});

describe("what the person sees of each argument", () => {
  it("leading, trailing and only-space arguments are quoted with every space marked", () => {
    expect(showArg(" bash")).toBe('"' + SPACE + 'bash"');
    expect(showArg("check.sh ")).toBe('"check.sh' + SPACE + '"');
    expect(showArg("   ")).toBe('"' + SPACE.repeat(3) + '"');
    expect(showArg("a b")).toBe('"a' + SPACE + 'b"');
  });
});

describe("a draft the server would refuse", () => {
  const ok = { argv: ["bash"], dev_shell: false, timeout_s: 60 };
  it("matches the server's bounds", () => {
    expect(draftProblem(ok)).toBe("");
    expect(draftProblem({ ...ok, argv: [] })).not.toBe("");
    expect(draftProblem({ ...ok, argv: Array(17).fill("a") })).not.toBe("");
    expect(draftProblem({ ...ok, argv: [""] })).not.toBe("");
    expect(draftProblem({ ...ok, argv: ["x".repeat(257)] })).not.toBe("");
    expect(draftProblem({ ...ok, argv: ["a\nb"] })).not.toBe("");
    expect(draftProblem({ ...ok, argv: ["café"] })).not.toBe("");
    for (const timeout_s of [59, 10801, 60.5, NaN]) expect(draftProblem({ ...ok, timeout_s })).not.toBe("");
    expect(draftProblem({ ...ok, timeout_s: 10800 })).toBe("");
  });
});

describe("the PUT body carries the whole approved set", () => {
  it("approving a check keeps the approved entries and timeout and sends the name", () => {
    expect(checkBody(withCheck(), CHECK, NAME)).toEqual({ set: { entries: [A], command_timeout_s: 600, check: CHECK }, confirm_repo: NAME });
  });
  it("a repo with nothing approved sends an empty entry list and no timeout", () => {
    expect(checkBody(view({ approved: null }), CHECK, NAME)).toEqual({ set: { entries: [], check: CHECK }, confirm_repo: NAME });
  });
  it("removing keeps the entries; a set with none is the safe direction and sends no name", () => {
    expect(checkBody(withCheck(), null, NAME)).toEqual({ set: { entries: [A], command_timeout_s: 600 }, confirm_repo: NAME });
    expect(checkBody(view({ approved: { version: 1, entries: [], check: CHECK } }), null, NAME)).toEqual({ set: { entries: [] } });
  });
});

describe("keepFocus", () => {
  // A small stand-in for the DOM: just what keepFocus reads and calls.
  const fake = () => {
    const mk = (id) => ({ id, disabled: false, focused: false, selectionStart: 2, selectionEnd: 2, getAttribute: () => "t", focus() { doc.activeElement = this; }, setSelectionRange(a, b) { this.sel = [a, b]; } });
    const doc = { activeElement: null };
    let nodes = [mk("a"), mk("b")];
    const root = { contains: (n) => nodes.includes(n), querySelectorAll: () => nodes };
    globalThis.document = doc;
    return { doc, root, get nodes() { return nodes; }, redraw: () => { nodes = [mk("a2"), mk("b2")]; } };
  };
  it("puts focus and the caret back on the same place after the nodes are rebuilt", () => {
    const f = fake();
    f.doc.activeElement = f.nodes[1];
    keepFocus(f.root, f.redraw);
    expect(f.doc.activeElement).toBe(f.nodes[1]);
    expect(f.nodes[1].id).toBe("b2");
    expect(f.nodes[1].sel).toEqual([2, 2]);
  });
  it("does nothing when focus was elsewhere", () => {
    const f = fake();
    keepFocus(f.root, f.redraw);
    expect(f.doc.activeElement).toBeNull();
  });
});
