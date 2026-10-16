// apps/workspace/test/staging-fixes.test.mjs
//
// Regressions for the UI and state bugs found in the 2026-10-16 staging tests (Refs D#6). The logic is pinned on the source modules; the
// "built output" block builds the real workspace into a scratch directory and reads what would ship, so a fix that never reaches dist/ turns it red.
// The real DOM (axe, focus, the dock preview) is driven on the built output in e2e/.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "../build/build.mjs";
import { exportTarget, runnerHeadTotal } from "../apps/runs/runs-detail.js";
import { accountText, controlList, readFleet, readRunner, stateParts, STATE_WORDS } from "../apps/runners/runners-fleet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const RUN = "11111111-1111-4111-8111-111111111111";
const ME = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const NOTE = "Resumes within 5 min";
const ok = { allowed: true, reason: null };
const wire = (over = {}) => ({
  id: R1, credential_mode: "api_key", registered_by: { id: ME, name: "Ada" }, binary_version: "0.9.1", last_seen_at: "2026-10-15T11:59:00.000Z", state: "online_idle", state_note: null, revoked_reason: null,
  sandbox_unavailable: null, plan_consent: { granted: false, changed_at: null }, can_change_plan_consent: false, repos: [], running: { light: 0, heavy: 0 },
  capacity: { light: { limit: 4, in_use: 0 }, heavy: { limit: 2, in_use: 0 }, total_limit: 4, limited_by: null }, load_label: null, provisioning: null, name: "Desktop", has_name: true, labels: [], facts: null,
  current_runs: [], paused: false, draining: false, controls: { pause: ok, drain: ok, resume: ok, rename: ok, remove: ok }, register_again: null, ...over,
});

describe("item 1: the runner state matrix as the card words it (D#605 FL-8: a drain with nothing running reads paused)", () => {
  const cases = [
    ["online", { state: "online_idle" }, "Online"],
    ["busy", { state: "busy", load_label: "Busy · 1 of 4" }, "Busy · 1 of 4"],
    ["paused", { state: "paused", paused: true, state_note: NOTE }, "Paused · " + NOTE],
    ["draining with work left", { state: "draining", draining: true, state_note: NOTE }, "Finishing current work"],
    ["paused and draining", { state: "paused", paused: true, draining: true, state_note: NOTE }, "Paused · " + NOTE],
    ["drained, nothing left to finish", { state: "paused", draining: true, state_note: NOTE }, "Paused · " + NOTE],
    ["offline", { state: "offline" }, "Offline"],
  ];
  for (const [name, over, words] of cases) {
    it(name + " reads '" + words + "'", () => {
      expect(stateParts(readRunner(wire(over))).words).toBe(words);
    });
  }
  it("a paused or draining runner offers Resume and not Pause; any other offers Pause and Finish current work", () => {
    const labels = (o) => controlList(readRunner(wire(o))).map((c) => c.label);
    expect(labels({ state: "paused", paused: true })).toEqual(["Resume", "Rename", "Remove"]);
    expect(labels({ state: "paused", draining: true })).toEqual(["Resume", "Rename", "Remove"]);
    expect(labels({ state: "online_idle" })).toEqual(["Pause", "Finish current work", "Rename", "Remove"]);
  });
  it("every state has words", () => {
    for (const s of ["online_idle", "busy", "paused", "draining", "offline", "outdated", "revoked"]) expect(STATE_WORDS[s]).toBeTruthy();
  });
});

describe("item 5: the Runners account line is bound to the API's account.capacity", () => {
  const body = (account) => ({ runners: [wire()], viewer: { role: "admin" }, account });
  it("capacity 4 of limit 4 reads 'Capacity 4 of account limit 4', not a per-runner figure", () => {
    const f = readFleet(body({ limit: 4, capacity: 4, running: 0, runner_count: 1, runner_limit: 5 }));
    expect(accountText(f.account)).toBe("Capacity 4 of account limit 4 · 0 running");
  });
  it("shows the API's capacity when it is below the limit, and never the runner's own in-use count", () => {
    const f = readFleet(body({ limit: 4, capacity: 1, running: 0, runner_count: 1, runner_limit: 5 }));
    expect(accountText(f.account)).toBe("Capacity 1 of account limit 4 · 0 running");
    expect(f.runners[0].capacity.total).toBe(4);
  });
});

describe("item 4: the runner run header total", () => {
  const ins = (usage, runtime = "runner") => ({ run: { runtime }, runner_usage: usage });
  it("a subscription run: API-equivalent total, on the customer's Claude plan", () => {
    expect(runnerHeadTotal(ins({ credential_mode: "subscription", api_equivalent_usd: 1.2345 }))).toBe("API-equivalent $1.23 · on your Claude plan");
  });
  it("an own-key run says so; no price or no usage never reads as $0", () => {
    expect(runnerHeadTotal(ins({ credential_mode: "api_key", api_equivalent_usd: 0.5 }))).toBe("$0.50 at API prices · on your own API key");
    expect(runnerHeadTotal(ins({ credential_mode: "subscription", api_equivalent_usd: null }))).toBe("On your Claude plan");
    expect(runnerHeadTotal(ins(null))).toBe("On your Claude plan");
  });
  it("a sandbox run and a missing insight have no runner total", () => {
    expect(runnerHeadTotal(ins(undefined, "sandbox"))).toBeNull();
    expect(runnerHeadTotal(null)).toBeNull();
  });
});

describe("item 3: the export control's target", () => {
  it("points at the export route and names the file after the run", () => {
    expect(exportTarget(RUN)).toEqual({ href: "/api/v1/runs/" + RUN + "/events/export", filename: "run-" + RUN + "-events.ndjson" });
  });
  it("a value that is not a run id gets no control (nothing is put in the URL)", () => {
    for (const bad of ["", "../x", RUN + "/../x", "<b>", null, undefined, 5]) expect(exportTarget(bad)).toBeNull();
  });
});

describe("item 2: every install outcome the callback can redirect with has a note", () => {
  it("the notes cover the callback's outcome union and its rate_limited redirect", () => {
    const union = readFileSync(join(ROOT, "packages", "github", "src", "installCallback.ts"), "utf8").match(/export type InstallOutcome =([^;]+);/)[1];
    const outcomes = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).concat("rate_limited");
    const src = readFileSync(join(HERE, "..", "apps", "repos", "repos-app.js"), "utf8");
    const block = src.slice(src.indexOf("const RETURN_NOTES"), src.indexOf("};", src.indexOf("const RETURN_NOTES")));
    for (const o of outcomes) expect(block, o).toMatch(new RegExp("\\b" + o + ': "[^"]{10,}"'));
  });
});

describe("built output", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
  const built = () => {
    const outDir = mkdtempSync(join(tmpdir(), "ws-staging-fixes-"));
    dirs.push(outDir);
    build({ outDir });
    return files(outDir).map((f) => [f, readFileSync(f, "utf8")]);
  };
  it("ships the install notes, the export control, the header total, the plan-table heading rule and the clean preview clone", () => {
    const all = built();
    const has = (needle) => all.some(([, text]) => text.includes(needle));
    for (const needle of [
      "GitHub hasn't confirmed the install yet.",
      "Only the GitHub user who installed the App can connect it.",
      "That GitHub installation is suspended or removed.",
      "/events/export",
      "Export events",
      "on your Claude plan",
    ]) expect(has(needle), needle).toBe(true);
    const css = all.filter(([f]) => f.endsWith(".css")).map(([, t]) => t).join("\n");
    expect(css).toMatch(/\.pl-plan-table th\[scope=["']?col["']?\][^}]*overflow-wrap:\s*normal/);
    const wm = all.find(([, t]) => t.includes("function sanitizePreviewClone"));
    expect(wm, "window manager").toBeTruthy();
    expect(wm[1]).toMatch(/removeAttribute\(['"]data-testid['"]\)/);
  });
});
