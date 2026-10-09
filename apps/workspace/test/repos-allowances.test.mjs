// apps/workspace/test/repos-allowances.test.mjs
//
// D#6 R7d: the Repos app's sandbox allowance panel, state by state. The panel's decisions are in panelModel (no DOM); the
// DOM wiring is exercised in the browser by e2e/repos-allowances.spec.ts. The vitest environment here is node.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../apps/_lib/api.js";
import { ADMIN_ONLY, MAX_FILE_BYTES, approveError, diffSets, entryRows, panelModel, parseUpload } from "../apps/repos/repos-allowances.js";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "repos", "repos-allowances.js"), "utf8");
const NAME = "acme/widgets";
const A = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install packages" };
const B = { kind: "path", value: "/nix/store", access: "read", reason: "the dev shell" };
const C = { kind: "loopback", value: "127.0.0.1", access: "bind", reason: "test database" };
const set = (entries, t = 600) => (entries.length ? { entries, command_timeout_s: t } : { entries });
const view = (over = {}) => ({
  repo_id: "r", execution_mode: "runner_local", in_use: true, set_aside: false, can_change: true,
  approved: { version: 1, entries: [A], command_timeout_s: 600, set_sha256: "ab".repeat(32), approved_at: "2026-10-09T00:00:00.000Z" }, ...over,
});
const state = (over = {}) => ({ load: "ok", view: view(), upload: null, typed: "", phase: "idle", repoName: NAME, ...over });

describe("panel states", () => {
  it("loading and failed loads show no set", () => {
    expect(panelModel(state({ load: "loading", view: null })).kind).toBe("loading");
    expect(panelModel(state({ load: "error", view: null })).kind).toBe("error");
  });
  it("no set: nothing approved, nothing pending", () => {
    const m = panelModel(state({ view: view({ approved: null, in_use: false }) }));
    expect(m.approved).toBeNull();
    expect(m.approvedRows).toBeNull();
    expect(m.pending).toBeNull();
    expect(m.approveDisabled).toBe(true);
  });
  it("approved only: its entries as rows, no diff, nothing to approve", () => {
    const m = panelModel(state());
    expect(m.approvedRows).toEqual([A]);
    expect(m.diff).toBeNull();
    expect(m.approveDisabled).toBe(true);
  });
  it("pending only: the diff adds every entry and approve waits for the name", () => {
    const m = panelModel(state({ view: view({ approved: null }), upload: { set: set([A, B]) } }));
    expect(m.diff.added).toEqual([A, B]);
    expect(m.diff.same).toBe(false);
    expect(m.needsName).toBe(true);
    expect(m.approveDisabled).toBe(true);
  });
  it("approved plus pending: the diff names what is added, removed and changed, and the timeout", () => {
    const d = diffSets(set([A, B], 600), set([{ ...A, reason: "new reason" }, C], 900));
    expect(d.added).toEqual([C]);
    expect(d.removed).toEqual([B]);
    expect(d.changed).toEqual([{ ...A, reason: "new reason" }]);
    expect(d.timeout).toEqual({ from: 600, to: 900 });
    expect(diffSets(set([A]), set([A])).same).toBe(true);
    expect(diffSets(null, set([])).same).toBe(false);
  });
  it("a set aside approval and a repo off the runner are carried through", () => {
    expect(panelModel(state({ view: view({ set_aside: true, in_use: false }) })).setAside).toBe(true);
    const m = panelModel(state({ view: view({ execution_mode: "cloud" }), upload: { set: set([B]) }, typed: NAME }));
    expect(m.notRunner).toBe(true);
    expect(m.approveDisabled).toBe(true); // the server would answer 409; the button does not offer it
  });
});

describe("a set-aside approval", () => {
  it("an identical upload counts as a change, so approving it again is offered once the name is typed", () => {
    const aside = view({ set_aside: true, in_use: false });
    const same = { set: set([A]) };
    const m = panelModel(state({ view: aside, upload: same, typed: NAME }));
    expect(m.diff.same).toBe(true);
    expect(m.restores).toBe(true);
    expect(m.approveDisabled).toBe(false);
    expect(panelModel(state({ view: aside, upload: same, typed: "acme/widget" })).approveDisabled).toBe(true); // the name gate still applies
    expect(panelModel(state({ view: view(), upload: same, typed: NAME })).approveDisabled).toBe(true); // not set aside: still no change
    expect(panelModel(state({ view: view(), upload: same, typed: NAME })).restores).toBe(false);
  });
  it("an empty upload over a set-aside empty set needs no name", () => {
    const aside = view({ set_aside: true, approved: { version: 1, entries: [], set_sha256: "ab".repeat(32), approved_at: "2026-10-09T00:00:00.000Z" } });
    expect(panelModel(state({ view: aside, upload: { set: set([]) } })).approveDisabled).toBe(false);
  });
});

describe("who may approve", () => {
  const pending = { upload: { set: set([A, B]) } };
  it("a member is read-only: can_change false disables approve whatever is typed", () => {
    const m = panelModel(state({ view: view({ can_change: false }), ...pending, typed: NAME }));
    expect(m.canChange).toBe(false);
    expect(m.approveDisabled).toBe(true);
    expect(ADMIN_ONLY).toBe("Only owners and admins can change this.");
  });
  it("an admin cannot approve until the typed name matches exactly", () => {
    for (const typed of ["", "acme", "ACME/WIDGETS", "acme/widgets ", " acme/widgets", "acme/widget"]) {
      expect(panelModel(state({ ...pending, typed })).approveDisabled).toBe(true);
    }
    expect(panelModel(state({ ...pending, typed: NAME })).approveDisabled).toBe(false);
  });
  it("a repo whose name is not known yet cannot be approved with entries", () => {
    const m = panelModel(state({ ...pending, repoName: "", typed: "" }));
    expect(m.nameKnown).toBe(false);
    expect(m.approveDisabled).toBe(true);
  });
  it("approve is off while the request is in flight", () => {
    expect(panelModel(state({ ...pending, typed: NAME, phase: "saving" })).approveDisabled).toBe(true);
  });
  it("an empty set needs no name (the safe direction) but still needs a change", () => {
    const m = panelModel(state({ upload: { set: set([]) } }));
    expect(m.widening).toBe(false);
    expect(m.needsName).toBe(false);
    expect(m.approveDisabled).toBe(false);
    expect(panelModel(state({ view: view({ approved: { version: 2, entries: [], command_timeout_s: null } }), upload: { set: set([]) } })).approveDisabled).toBe(true);
  });
});

describe("the picked file", () => {
  const ok = (v) => parseUpload(JSON.stringify(v));
  it("a good file becomes a clean set with only the four fields", () => {
    const r = ok({ entries: [{ ...A, extra: 1 }], command_timeout_s: 60 });
    expect(r.ok).toBe(false); // an extra key is refused, never passed through
    expect(ok({ entries: [A], command_timeout_s: 60 })).toEqual({ ok: true, set: { entries: [A], command_timeout_s: 60 } });
    expect(ok({ entries: [] })).toEqual({ ok: true, set: { entries: [] } });
  });
  it("a malformed file gets a closed code, never the parser's text", () => {
    expect(parseUpload("{ not json")).toEqual({ ok: false, code: "not_json" });
    expect(parseUpload("")).toEqual({ ok: false, code: "not_json" });
    expect(parseUpload("x".repeat(MAX_FILE_BYTES + 1))).toEqual({ ok: false, code: "too_big" });
    for (const bad of [[], null, 7, {}, { entries: "no" }, { entries: [A], command_timeout_s: 0 }, { entries: [A], command_timeout_s: 1801 }, { entries: [A], command_timeout_s: 1.5 },
      { entries: [{ ...A, value: "" }] }, { entries: [{ ...A, value: "   " }] }, { entries: [{ ...A, reason: undefined }] }, { entries: [A, 3] }, { entries: [A], other: 1 },
      { entries: Array.from({ length: 65 }, () => A) }]) {
      expect(ok(bad)).toEqual({ ok: false, code: "malformed" });
    }
  });
});

describe("a floor-refused upload and the approve outcomes", () => {
  it("shows the server's closed reason and the entry, not the server's text", () => {
    const e = { status: 400, code: "sandbox_allowance_refused", message: "SERVER TEXT <b>x</b>", reason: "path_credential", index: 1 };
    const text = approveError(e);
    expect(text).toBe("The server refused this set: a path holds credentials (entry 2).");
    expect(text).not.toContain("SERVER TEXT");
    expect(approveError({ ...e, reason: "made_up", index: undefined })).toBe("The server refused this set: it crosses the sandbox floor.");
  });
  it("approve error: each failure has its own sentence, and an unknown one is generic", () => {
    expect(approveError({ status: 400, code: "confirmation_mismatch" })).toBe("The name you typed doesn't match this repo.");
    expect(approveError({ status: 409, code: "not_runner_local" })).toBe("Allowances are only for repos that run on a runner.");
    expect(approveError({ status: 403, code: "forbidden" })).toBe(ADMIN_ONLY);
    expect(approveError({ status: 500, code: "server_error" })).toBe("That couldn't be saved. Try again.");
    expect(approveError(null)).toBe("That couldn't be saved. Try again.");
  });
});

describe("an empty value never shows", () => {
  it("rows never hold a blank, null or undefined", () => {
    const rows = entryRows([{ kind: "path", value: "", access: "read", reason: null }, { kind: "path" }, null]);
    for (const row of rows) for (const v of Object.values(row)) expect(v).toMatch(/\S/);
    expect(JSON.stringify(rows)).not.toMatch(/null|undefined/);
    expect(entryRows(undefined)).toEqual([]);
  });
});

describe("the source", () => {
  it("has no markup sink, no direct fetch and never reads a server message", () => {
    expect(SRC).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bfetch\(|\.message\b/);
  });
});

describe("api() carries the runner route's closed refusal", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body), headers: { get: () => null } });
  it("keeps a short reason code and an entry index beside the error, and drops free text", async () => {
    fetch.mockResolvedValue(reply(400, { error: { code: "sandbox_allowance_refused", message: "m" }, reason: "path_home", index: 3 }));
    const err = await api("PUT", "/api/runners/repos/x/sandbox-allowances", {}).catch((e) => e);
    expect([err.status, err.code, err.reason, err.index]).toEqual([400, "sandbox_allowance_refused", "path_home", 3]);
    fetch.mockResolvedValue(reply(400, { error: { code: "c" }, reason: "<b>not a code</b>", index: -1 }));
    const bad = await api("PUT", "/api/runners/repos/x/sandbox-allowances", {}).catch((e) => e);
    expect([bad.reason, bad.index]).toEqual([undefined, undefined]);
  });
});
