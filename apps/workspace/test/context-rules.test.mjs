// apps/workspace/test/context-rules.test.mjs
//
// D#600 CX-9b: the context rules panel (apps/_lib/context-rules.js), state by state. The decisions are in the model functions and the two
// controllers (no DOM); the DOM wiring (keyboard, focus, toast, role="alert", layout, axe) is driven in a browser by e2e/context-rules.spec.ts.
// The sentences are the fixed tables COPY and REFUSALS; the constants they quote are read from the source modules, never typed here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_ONLY, COPY, PINS_MAX_READ, REFUSALS, UNDO_MS, budgetInput, budgetStatusLine, checkPath, createBudgetController, createRulesController, distinguishing, readLimitLine, refusalSentence,
  ruleRows, splitPath,
} from "../apps/_lib/dom.js";
import { isPinPath, PINS_MAX_READ as REAL_PINS_MAX_READ } from "../../../packages/runner-protocol/src/pinRules.ts";
import { isRuleablePath } from "../../../packages/runner-protocol/src/excludeRules.ts";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const read = (rel) => readFileSync(join(PACKAGES, rel), "utf8");
const REPO = "33333333-3333-4333-8333-333333333333";
const ITEM = "55555555-5555-4555-8555-555555555555";
const fail = (status, code, extra) => Object.assign(new Error("server text that must never be shown"), { status, code, ...extra });
const rule = (kind, path, scope = "repo", id = "id-" + scope + "-" + path) => ({ id, kind, scope, path });
const fixture = (...p) => JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", ...p), "utf8"));
const allText = (o) => Object.values(o).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "function" ? [v("src/a.ts", 4096), v(3, 4)] : []));

/** A call() answering by "METHOD path-without-query"; a function value is called with (body, fullPath), an Error is thrown. */
function fakeCall(routes) {
  const log = [];
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const key = method + " " + path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
    const r = routes[key];
    const v = typeof r === "function" ? r(body, path) : r;
    if (v instanceof Error) throw v;
    return v;
  });
  call.log = log;
  return call;
}
const admin = (is) => async () => is;

describe("the copy tables", () => {
  const route = read("api/src/routes/context-rules.ts");
  const own = (() => { const t = read("telemetry/src/errorCodes.ts"); const at = t.indexOf("export const OWN_ERROR_CODES"); return [...t.slice(at, t.indexOf("\n]", at)).matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]); })();

  it("CX-9b-2: 'Kept out of context' is never beside the word 'Enforced' (and no sentence uses it at all)", () => {
    const every = [...allText(COPY), ...Object.values(REFUSALS)];
    expect(every.length).toBeGreaterThan(40);
    expect(COPY.exclude).toBe("Kept out of context");
    for (const text of every) {
      expect(text, text).not.toMatch(/enforc/i);
    }
    expect(COPY.help).toBe("Not a security boundary: tests and shell commands can still read it");
  });

  it("CX-9b-10: every code the routes send has its own sentence, and each is an OWN_ERROR_CODES entry", () => {
    const at = route.indexOf("const REFUSALS");
    const served = [...route.slice(at, route.indexOf("\n};", at)).matchAll(/^\s+([a-z_]+): \[\d+,/gm)].map((m) => m[1]);
    expect(served.length).toBe(9);
    const wire = [...new Set([...served, "insufficient_role", "not_found"])];
    expect(Object.keys(REFUSALS).sort()).toEqual(wire.sort()); // a code with no sentence, or a sentence for no code, fails here
    for (const code of wire) {
      // insufficient_role is sent by the API's role check (errors.ts), the rest are OWN_ERROR_CODES entries
      if (code === "insufficient_role") expect(read("api/src/errors.ts")).toContain('code: "insufficient_role"');
      else expect(own, code).toContain(code);
      expect(refusalSentence(fail(409, code))).toBe(REFUSALS[code]);
    }
    // the two codes of the DB that never reach the wire are not in the table
    expect(Object.keys(REFUSALS)).not.toContain("insufficient_privilege");
    expect(Object.keys(REFUSALS)).not.toContain("no_data_found");
  });

  it("an unknown code falls back by status, then to one generic sentence; a 429 counts down", () => {
    expect(refusalSentence(fail(403, "something_new"))).toBe(ADMIN_ONLY);
    expect(refusalSentence(fail(404, "something_new"))).toBe(REFUSALS.not_found);
    expect(refusalSentence(fail(500, "server_error"))).toBe("That change couldn't be saved. Try again.");
    expect(refusalSentence(undefined)).toBe("That change couldn't be saved. Try again.");
    expect(refusalSentence(fail(429, "rate_limited", { retryAfter: 8 }))).toBe("Too many changes. Try again in 8 seconds.");
    expect(refusalSentence(fail(429, "rate_limited"))).toMatch(/^Too many changes\. Try again in 10 seconds\.$/);
    expect(REFUSALS.pins_exceed_budget).not.toContain("server text");
  });

  it("CX-9b-10: no sentence shows null, undefined or NaN, whatever a function entry is given", () => {
    for (const text of [...allText(COPY), ...Object.values(REFUSALS), budgetStatusLine("over_budget"), budgetStatusLine("not_measured"), budgetStatusLine("fit")]) {
      expect(text).not.toMatch(/\b(null|undefined|NaN)\b/);
      expect(text).not.toMatch(/\{|\}|%s|\$\{/);
    }
    expect(COPY.budgetNow(null)).toBe("Now: each role's default.");
    expect(budgetStatusLine("anything else")).toBe("");
  });

  it("the Spec's wording is in the tables", () => {
    expect(COPY.applies).toBe("Applies from the next run");
    expect(COPY.undo).toBe("Undo");
    expect(COPY.retry).toBe("Retry");
    expect(COPY.reset).toBe("Reset to default");
    expect(COPY.bracket).toContain("[id]");
    expect(COPY.bracket).toMatch(/\? or \*/);
    expect(COPY.overBudget).toBe("Your pins are over this budget. They are never cut to fit it during a run.");
    expect(COPY.readdsPins).toBe("Removing this exclude puts pinned files back in this item's runs, and they no longer fit the budget. Remove it anyway?");
    expect(UNDO_MS).toBe(10000);
  });
});

describe("CX-9b-9: the read-limit line", () => {
  const pins = (n) => Array.from({ length: n }, (_, i) => rule("pin", "src/f" + i + ".ts"));
  it("reads the number from the source module, and the workspace constant equals it", () => {
    const src = read("runner-protocol/src/pinRules.ts").match(/export const PINS_MAX_READ = (\d+);/);
    expect(src).not.toBeNull();
    expect(PINS_MAX_READ).toBe(Number(src[1]));
    expect(PINS_MAX_READ).toBe(REAL_PINS_MAX_READ);
  });
  it("shows no line at exactly the limit, and the line at one more, with the real number in it", () => {
    expect(readLimitLine(pins(REAL_PINS_MAX_READ - 1))).toBe("");
    expect(readLimitLine(pins(REAL_PINS_MAX_READ))).toBe("");
    const line = readLimitLine(pins(REAL_PINS_MAX_READ + 1));
    expect(line).toBe("A run reads at most " + REAL_PINS_MAX_READ + " of the pinned files. The rest are saved but not read.");
  });
  it("counts pins only: many excludes add nothing", () => {
    const set = [...pins(REAL_PINS_MAX_READ), ...Array.from({ length: 60 }, (_, i) => rule("exclude", "gen/g" + i + "/**"))];
    expect(readLimitLine(set)).toBe("");
  });
});

describe("paths: the same rules the server applies", () => {
  const TABLE = ["", " ", "src/a.ts", "app/[id]/page.tsx", "a/*.ts", "a/?.ts", "**/x", "/abs", "~/h", "a//b", "a/./b", "a/../b", "a\\b", "a\nb", "a/b/", "ok/{x}", "é/ü.ts", "x".repeat(512), "x".repeat(513), "😀".repeat(512), "😀".repeat(513), ".", "..", "a b/c d", "tab\there"];
  it("checkPath agrees with the server's isRuleablePath (exclude) and isPinPath (pin) on every case", () => {
    for (const p of TABLE) {
      expect(checkPath(p, "exclude"), JSON.stringify(p)).toBe(isRuleablePath(p));
      expect(checkPath(p, "pin"), JSON.stringify(p)).toBe(isPinPath(p));
    }
  });
  it("splits a path into its folder (dimmed) and name", () => {
    expect(splitPath("src/app/page.tsx")).toEqual({ dir: "src/app/", name: "page.tsx" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("rows: the nearest distinguishing folder, order and who may edit", () => {
  it("same-name files are told apart by the fewest trailing folders that differ", () => {
    const rs = [rule("pin", "docs/README.md"), rule("pin", "src/README.md"), rule("pin", "src/a/index.ts"), rule("pin", "src/b/index.ts"), rule("pin", "pkg/src/a/index.ts"), rule("pin", "only.ts")];
    const told = distinguishing(rs);
    expect(told.get("repo:docs/README.md")).toBe("docs/");
    expect(told.get("repo:src/README.md")).toBe("src/");
    expect(told.get("repo:src/a/index.ts")).toBe("src/a/");
    expect(told.get("repo:src/b/index.ts")).toBe("b/");
    expect(told.get("repo:pkg/src/a/index.ts")).toBe("pkg/src/a/");
    expect(told.has("repo:only.ts")).toBe(false);
  });
  it("a top-level file with the same name as another is told apart by the top level", () => {
    const told = distinguishing([rule("pin", "README.md"), rule("pin", "docs/README.md")]);
    expect(told.get("repo:README.md")).toBe(COPY.topLevel);
    expect(told.get("repo:docs/README.md")).toBe("docs/");
  });
  it("sorts by path, marks an exclude with a bracket, and lets a member change only item rules", () => {
    const rs = [rule("exclude", "z/[id]/p.ts", "item"), rule("pin", "a/b.ts", "repo")];
    const member = ruleRows(rs, { isAdmin: false });
    expect(member.map((r) => r.path)).toEqual(["a/b.ts", "z/[id]/p.ts"]);
    expect(member.map((r) => r.canEdit)).toEqual([false, true]);
    expect(member[1].bracket).toBe(true);
    expect(member[0].bracket).toBe(false);
    expect(ruleRows(rs, { isAdmin: true }).every((r) => r.canEdit)).toBe(true);
  });
});

describe("the rules controller", () => {
  const listed = (data) => ({ "GET /api/v1/context-rules": () => ({ data }) });
  async function ready(data = [], routes = {}, target = { repoId: REPO }, isAdmin = true) {
    const call = fakeCall({ ...listed(data), ...routes });
    const ctl = createRulesController({ call, getAdmin: admin(isAdmin), target });
    await ctl.start();
    return { call, ctl };
  }
  const writes = (call) => call.log.filter((a) => a[0] !== "GET");

  it("loads a repository's rules by repo_id and an item's by work_item_id, keeping only well-formed rows", async () => {
    const { call, ctl } = await ready([{ id: "a", kind: "pin", scope: "repo", path: "x.ts" }, { id: "b", kind: "weird", scope: "repo", path: "y" }, null, { id: "c", kind: "pin", scope: "repo", path: "" }]);
    expect(call.log[0][1]).toBe("/api/v1/context-rules?repo_id=" + REPO);
    expect(ctl.state.load).toBe("ok");
    expect(ctl.state.rules.map((r) => r.id)).toEqual(["a"]);
    const item = await ready([], {}, { repoId: REPO, itemId: ITEM });
    expect(item.call.log[0][1]).toBe("/api/v1/context-rules?work_item_id=" + ITEM);
    expect(item.ctl.state.scope).toBe("item");
  });

  it("reads the real fixture shapes (list, empty)", async () => {
    const { ctl } = await ready(fixture("listContextRules", "200-rules.json").data);
    expect(ctl.state.rules).toHaveLength(4);
    const empty = await ready(fixture("listContextRules", "200-empty.json").data);
    expect(empty.ctl.state.rules).toEqual([]);
    expect(empty.ctl.state.load).toBe("ok");
  });

  it("a failed read is the error state, not an empty list, and load(false) tries again", async () => {
    let ok = false;
    const call = fakeCall({ "GET /api/v1/context-rules": () => (ok ? { data: [] } : fail(503, "server_error")) });
    const ctl = createRulesController({ call, getAdmin: admin(true), target: { repoId: REPO } });
    await ctl.start();
    expect(ctl.state.load).toBe("error");
    ok = true;
    await ctl.load(false);
    expect(ctl.state.load).toBe("ok");
  });

  it("add sends exactly the route's body for each scope, trims the path, and re-reads", async () => {
    const { call, ctl } = await ready([], { "PUT /api/v1/context-rules": (b) => ({ id: "n", ...b }) }, { repoId: REPO, itemId: ITEM });
    expect(await ctl.add("  src/a.ts ", "pin", "item")).toBe("ok");
    expect(await ctl.add("docs/**", "exclude", "repo")).toBe("ok");
    expect(writes(call).map((w) => w[2])).toEqual([
      { scope: "item", work_item_id: ITEM, kind: "pin", path: "src/a.ts" },
      { scope: "repo", repo_id: REPO, kind: "exclude", path: "docs/**" },
    ]);
    expect(call.log.filter((a) => a[0] === "GET" && a[1].startsWith("/api/v1/context-rules?")).length).toBe(3); // the start read plus one after each write
  });

  it("a pin with * or ? and a path outside the repository are refused here with the invalid_path sentence, and nothing is sent", async () => {
    const { call, ctl } = await ready();
    for (const [p, k] of [["src/*.ts", "pin"], ["", "exclude"], ["../x", "exclude"], ["/etc/passwd", "pin"]]) {
      expect(await ctl.add(p, k, "repo")).toBe("failed");
      expect(ctl.state.error.text).toBe(REFUSALS.invalid_path);
      expect(ctl.state.error.retry).toBeNull();
    }
    expect(writes(call)).toEqual([]);
    expect(await ctl.add("src/*.ts", "exclude", "repo")).toBe("ok"); // a glob is allowed in an exclude
  });

  it("CX-9b-3: a save that fails keeps the rows, says why, and offers Retry that sends the same save again", async () => {
    let up = false;
    const data = [rule("pin", "keep/me.ts")];
    const { call, ctl } = await ready(data, { "PUT /api/v1/context-rules": () => (up ? { id: "n" } : fail(503, "tree_unavailable")) });
    expect(await ctl.add("src/a.ts", "pin", "repo")).toBe("failed");
    expect(ctl.state.rules.map((r) => r.path)).toEqual(["keep/me.ts"]);
    expect(ctl.state.error.text).toBe(REFUSALS.tree_unavailable);
    expect(typeof ctl.state.error.retry).toBe("function");
    up = true;
    expect(await ctl.state.error.retry()).toBe("ok");
    expect(ctl.state.error).toBeNull();
    expect(writes(call).map((w) => w[2].path)).toEqual(["src/a.ts", "src/a.ts"]);
  });

  it("CX-9b-4: pins_exceed_budget is the error with its own sentence (the view puts it in a role=alert region)", async () => {
    const { ctl } = await ready([], { "PUT /api/v1/context-rules": () => fail(409, "pins_exceed_budget") });
    await ctl.add("big/file.ts", "pin", "repo");
    expect(ctl.state.error.code).toBe("pins_exceed_budget");
    expect(ctl.state.error.text).toBe(REFUSALS.pins_exceed_budget);
    expect(ctl.state.error.text).not.toContain("server text");
  });

  it("every refusal the save route answers shows its sentence and writes nothing locally", async () => {
    for (const code of Object.keys(REFUSALS)) {
      const { ctl } = await ready([rule("pin", "a.ts")], { "PUT /api/v1/context-rules": () => fail(409, code) });
      expect(await ctl.add("b.ts", "pin", "repo")).toBe("failed");
      expect(ctl.state.error.text).toBe(REFUSALS[code]);
      expect(ctl.state.rules).toHaveLength(1);
    }
  });

  it("a 403 turns this person into a reader at once (the server's answer stays the real one)", async () => {
    const { ctl } = await ready([], { "PUT /api/v1/context-rules": () => fail(403, "insufficient_role") }, { repoId: REPO, itemId: ITEM });
    expect(ctl.state.isAdmin).toBe(true);
    await ctl.add("a.ts", "pin", "repo");
    expect(ctl.state.isAdmin).toBe(false);
    expect(ctl.state.error.text).toBe(ADMIN_ONLY);
  });

  it("CX-9b-1: toggle sends the other kind for the same path and scope; a glob exclude can't become a pin", async () => {
    const { call, ctl } = await ready([rule("pin", "a/b.ts", "item"), rule("exclude", "g/**", "repo")], { "PUT /api/v1/context-rules": (b) => ({ id: "n", ...b }) }, { repoId: REPO, itemId: ITEM });
    expect(await ctl.toggle(ctl.state.rules[0])).toBe("ok");
    expect(writes(call)[0][2]).toEqual({ scope: "item", work_item_id: ITEM, kind: "exclude", path: "a/b.ts" });
    expect(await ctl.toggle(ctl.state.rules[1])).toBe("failed");
    expect(ctl.state.error.text).toBe(REFUSALS.invalid_path);
    expect(writes(call)).toHaveLength(1);
  });

  it("CX-9b-1: remove calls DELETE for that id, re-reads, and Undo (add of the same rule) is a real save of the same body", async () => {
    let rows = [rule("pin", "a/b.ts", "repo", "11111111-1111-4111-8111-111111111111")];
    const routes = {
      "GET /api/v1/context-rules": () => ({ data: rows }),
      "DELETE /api/v1/context-rules/:id": () => ((rows = []), { removed: true }),
      "PUT /api/v1/context-rules": (b) => ((rows = [{ id: "n", ...b }]), { id: "n", ...b }),
    };
    const call = fakeCall(routes);
    const ctl = createRulesController({ call, getAdmin: admin(true), target: { repoId: REPO } });
    await ctl.start();
    const removed = ctl.state.rules[0];
    expect(await ctl.remove(removed, false)).toBe("ok");
    expect(call.log.find((a) => a[0] === "DELETE")[1]).toBe("/api/v1/context-rules/11111111-1111-4111-8111-111111111111");
    expect(ctl.state.rules).toEqual([]);
    expect(await ctl.add(removed.path, removed.kind, removed.scope)).toBe("ok");
    expect(writes(call)[1][2]).toEqual({ scope: "repo", repo_id: REPO, kind: "pin", path: "a/b.ts" });
    expect(ctl.state.rules.map((r) => r.path)).toEqual(["a/b.ts"]);
  });

  it("Undo (restore) re-reads first and writes the old rule when nothing sits at that path", async () => {
    let rows = [];
    const call = fakeCall({
      "GET /api/v1/context-rules": () => ({ data: rows }),
      "PUT /api/v1/context-rules": (b) => ((rows = [{ id: "n", ...b }]), { id: "n", ...b }),
    });
    const ctl = createRulesController({ call, getAdmin: admin(true), target: { repoId: REPO } });
    await ctl.start();
    expect(await ctl.restore(rule("pin", "a/b.ts", "repo"))).toBe("ok");
    expect(call.log.map((x) => x[0])).toEqual(["GET", "GET", "PUT", "GET"]);
    expect(writes(call)[0][2]).toEqual({ scope: "repo", repo_id: REPO, kind: "pin", path: "a/b.ts" });
  });

  it("Undo does not overwrite a rule another tab put at that path: a fixed sentence, no PUT, and the list shows what is there", async () => {
    let rows = [];
    const call = fakeCall({
      "GET /api/v1/context-rules": () => ({ data: rows }),
      "PUT /api/v1/context-rules": () => { throw new Error("must not write"); },
    });
    const ctl = createRulesController({ call, getAdmin: admin(true), target: { repoId: REPO } });
    await ctl.start();
    rows = [rule("exclude", "a/b.ts", "repo", "22222222-2222-4222-8222-222222222222")]; // another tab added an exclude meanwhile
    expect(await ctl.restore(rule("pin", "a/b.ts", "repo"))).toBe("failed");
    expect(writes(call)).toHaveLength(0);
    expect(ctl.state.error.text).toBe(COPY.changedElsewhere);
    expect(ctl.state.error.text).toBe("This rule was changed somewhere else, so it was not restored. The list now shows what is there.");
    expect(ctl.state.error.retry).toBeNull();
    expect(ctl.state.rules.map((r) => r.kind)).toEqual(["exclude"]);
  });

  it("CX-9b-6: a 409 exclude_readds_pins removes nothing and holds the rule for a confirmation; the confirm repeats with ?confirm=true", async () => {
    const ex = rule("exclude", "docs/**", "item", "22222222-2222-4222-8222-222222222222");
    let confirmed = false;
    const routes = {
      "GET /api/v1/context-rules": () => ({ data: confirmed ? [] : [ex] }),
      "DELETE /api/v1/context-rules/:id": (_b, path) => (path.endsWith("?confirm=true") ? ((confirmed = true), { removed: true }) : fail(409, "exclude_readds_pins")),
    };
    const call = fakeCall(routes);
    const ctl = createRulesController({ call, getAdmin: admin(true), target: { repoId: REPO, itemId: ITEM } });
    await ctl.start();
    expect(await ctl.remove(ctl.state.rules[0], false)).toBe("warned");
    expect(ctl.state.warn.rule.id).toBe(ex.id);
    expect(ctl.state.error).toBeNull();
    expect(ctl.state.rules).toHaveLength(1);
    expect(REFUSALS.exclude_readds_pins).toBe(COPY.readdsPins);
    expect(await ctl.remove(ctl.state.warn.rule, true)).toBe("ok");
    expect(call.log.filter((a) => a[0] === "DELETE").map((a) => a[1])).toEqual(["/api/v1/context-rules/" + ex.id, "/api/v1/context-rules/" + ex.id + "?confirm=true"]);
    expect(ctl.state.warn).toBeNull();
    expect(ctl.state.rules).toEqual([]);
  });

  it("a second 409 on the confirmed call is an error with its sentence, not a loop", async () => {
    const { ctl } = await ready([rule("exclude", "a", "item", "33333333-3333-4333-8333-333333333334")], { "DELETE /api/v1/context-rules/:id": () => fail(409, "exclude_readds_pins") }, { repoId: REPO, itemId: ITEM });
    expect(await ctl.remove(ctl.state.rules[0], true)).toBe("failed");
    expect(ctl.state.error.text).toBe(REFUSALS.exclude_readds_pins);
  });

  it("a failed removal keeps the row and offers Retry; a write while one is running is ignored", async () => {
    let gate;
    const wait = new Promise((r) => (gate = r));
    const { call, ctl } = await ready([rule("pin", "a.ts", "repo", "44444444-4444-4444-8444-444444444444")], { "DELETE /api/v1/context-rules/:id": () => fail(500, "server_error") });
    expect(await ctl.remove(ctl.state.rules[0], false)).toBe("failed");
    expect(ctl.state.rules).toHaveLength(1);
    expect(typeof ctl.state.error.retry).toBe("function");
    const slow = createRulesController({ call: async (m) => { if (m === "PUT") await wait; return m === "GET" ? { data: [] } : {}; }, getAdmin: admin(true), target: { repoId: REPO } });
    await slow.start();
    const first = slow.add("a.ts", "pin", "repo");
    expect(await slow.add("b.ts", "pin", "repo")).toBe("failed");
    gate();
    expect(await first).toBe("ok");
    expect(call.log.filter((a) => a[0] === "DELETE")).toHaveLength(1);
  });

  it("dismiss clears the warning and the error", async () => {
    const { ctl } = await ready([], { "PUT /api/v1/context-rules": () => fail(409, "context_rules_busy") });
    await ctl.add("a.ts", "pin", "repo");
    expect(ctl.state.error.text).toBe(REFUSALS.context_rules_busy);
    ctl.dismiss();
    expect(ctl.state.error).toBeNull();
  });
});

describe("the budget controller", () => {
  const view = (bytes) => ({ ...fixture("getRepoContextSettings", "200-ok.json"), context_budget_bytes: bytes });
  async function ready(routes = {}, isAdmin = true, bytes = null) {
    let current = bytes;
    const call = fakeCall({
      "GET /api/v1/repos/:id/context-settings": () => view(current),
      "PUT /api/v1/repos/:id/context-settings": (b) => ((current = b.context_budget_bytes), { ...view(current), changed: true, pins_status: "fit" }),
      ...routes,
    });
    const ctl = createBudgetController({ call, getAdmin: admin(isAdmin), repoId: REPO });
    await ctl.start();
    return { call, ctl };
  }
  const puts = (call) => call.log.filter((a) => a[0] === "PUT");

  it("reads the real fixture: role defaults read-only, the range, and no stored number", async () => {
    const { call, ctl } = await ready();
    expect(call.log.find((a) => a[0] === "GET" && a[1].includes("context-settings"))[1]).toBe("/api/v1/repos/" + REPO + "/context-settings");
    expect(ctl.state.load).toBe("ok");
    expect(ctl.state.view.bytes).toBeNull();
    expect(ctl.state.view.defaults.map((d) => d[0])).toEqual(["executor", "fix", "code-reviewer", "acceptance-tester", "security-reviewer", "debater"]);
  });

  it("a malformed answer is the error state, never a screen of blanks", async () => {
    const { ctl } = await ready({ "GET /api/v1/repos/:id/context-settings": () => ({ nothing: 1 }) });
    expect(ctl.state.load).toBe("error");
  });

  it("CX-9b-7: save sends the whole bytes typed; out of range, fractions and text are refused here", async () => {
    const { call, ctl } = await ready();
    for (const bad of ["", "abc", "4095", "2097153", "5000.5", "-1", "1e5", "NaN"]) {
      expect(await ctl.save(bad), bad).toBe(false);
      expect(ctl.state.error.text).toBe(COPY.budgetRange(4096, 2097152));
    }
    expect(puts(call)).toEqual([]);
    expect(await ctl.save(" 8192 ")).toBe(true);
    expect(puts(call)[0][2]).toEqual({ context_budget_bytes: 8192 });
    expect(ctl.state.view.bytes).toBe(8192); // re-read, not stamped
    expect(ctl.state.saved).toBe(true);
  });

  it("CX-9b-7: Reset to default writes null and the screen then shows the default", async () => {
    const { call, ctl } = await ready({}, true, 8192);
    expect(await ctl.reset()).toBe(true);
    expect(puts(call)[0][2]).toEqual({ context_budget_bytes: null });
    expect(ctl.state.view.bytes).toBeNull();
  });

  it("CX-9b-7: a lowered budget answers over_budget and the sentence says pins are never cut", async () => {
    const over = fixture("putRepoContextSettings", "200-over_budget.json");
    const { ctl } = await ready({ "PUT /api/v1/repos/:id/context-settings": () => over });
    await ctl.save("4096");
    expect(ctl.state.status).toBe("over_budget");
    expect(budgetStatusLine(ctl.state.status)).toMatch(/never cut to fit it during a run/);
    const reset = fixture("putRepoContextSettings", "200-reset.json");
    expect(reset.pins_status).toBe("fit");
    expect(budgetStatusLine("not_measured")).toMatch(/couldn't be checked/);
  });

  it("a failed budget write keeps the old number and offers Retry; a member's 403 is the admin-only sentence", async () => {
    let up = false, stored = 8192;
    const { ctl } = await ready({
      "GET /api/v1/repos/:id/context-settings": () => view(stored),
      "PUT /api/v1/repos/:id/context-settings": (b) => (up ? ((stored = b.context_budget_bytes), { ...view(stored), changed: true, pins_status: "fit" }) : fail(403, "insufficient_role")),
    }, true, 8192);
    expect(await ctl.save("9000")).toBe(false);
    expect(ctl.state.error.text).toBe(ADMIN_ONLY);
    expect(ctl.state.isAdmin).toBe(false);
    expect(ctl.state.view.bytes).toBe(8192);
    up = true;
    expect(await ctl.state.error.retry()).toBe(true);
    expect(ctl.state.view.bytes).toBe(9000);
  });

  it("budgetInput accepts the bounds exactly", () => {
    const v = { min_bytes: 4096, max_bytes: 2097152 };
    expect(budgetInput("4096", v)).toEqual({ ok: true, bytes: 4096 });
    expect(budgetInput("2097152", v)).toEqual({ ok: true, bytes: 2097152 });
    expect(budgetInput("0", v).ok).toBe(false);
  });
});
