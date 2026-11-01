// apps/workspace/test/roles-autonomy-limits.test.mjs
//
// D#483 S5-h: the pure rules of the Autonomy view's build, auto-start, margin and discovery rows, and the inventory that these settings live
// on that one surface only (S5h-3). The DOM behaviour is in e2e/roles-autonomy-limits.spec.ts; the vitest environment here is node.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BASIS_TEXT, LIM_COPY, SOURCE_TEXT, limFailureText, fmtCents, fmtMinutes, fmtUsd, fmtWhen, historyLine, parseCount, parseMargin, parseWeekly, previewFacts } from "../apps/roles/roles-autonomy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V1 = join(ROOT, "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const NEVER = /undefined|null|NaN|\[object/;

describe("figures", () => {
  it("formats money and time, and prints nothing for a missing or broken number", () => {
    expect(fmtCents(1250)).toBe("$12.50");
    expect(fmtCents(-300)).toBe("-$3.00");
    expect(fmtUsd(27.5)).toBe("$27.50");
    expect(fmtMinutes(45)).toBe("45 minutes");
    expect(fmtMinutes(1)).toBe("1 minute");
    expect(fmtMinutes(60)).toBe("1 hour");
    expect(fmtMinutes(125)).toBe("2 hours 5 minutes");
    for (const bad of [undefined, null, NaN, Infinity, "5"]) {
      expect(fmtCents(bad)).toBe("");
      expect(fmtUsd(bad)).toBe("");
      expect(fmtMinutes(bad)).toBe("");
    }
  });

  it("a history line names the old and new number, the person and the date, and survives a bad date", () => {
    const [newest] = fx("getAccountBuildConcurrencyHistory", "200-ok.json").changes;
    const line = historyLine(newest);
    expect(line).toMatch(/^Changed from 2 to 10 by Ada Admin on .*2026/);
    expect(line).not.toMatch(NEVER);
    expect(historyLine({ from: 1, to: 2, changed_by_name: "A team member", changed_at: "garbage" })).toBe("Changed from 1 to 2 by A team member on an unknown date");
    expect(fmtWhen(undefined)).toBe("an unknown date");
  });
});

describe("a build-limit preview shows only what the server sent", () => {
  const full = { clear_minutes_old: 120, clear_minutes_new: 60, extra_per_hour_cents: 150, extra_per_day_cents: 3600, queue_total_cents: 9000, unpriced_items: 2, basis: "history" };
  it("lists time, spend, queue total, unpriced count and basis", () => {
    expect(previewFacts(full)).toEqual([
      "Time to clear the queue: 2 hours now, 1 hour after this change",
      "Extra spend per hour: $1.50",
      "Extra spend per day: $36.00",
      "Whole queue: $90.00",
      "Items with no estimate: 2",
      "Priced from: your recent runs",
    ]);
  });
  it("leaves out the spend lines when there is nothing to price from, and prints a lowering as a saving", () => {
    const none = previewFacts({ clear_minutes_old: 30, clear_minutes_new: 30, unpriced_items: 0, basis: "none" });
    expect(none.join("|")).not.toMatch(/Extra spend|Whole queue/);
    expect(none).toContain("Priced from: nothing yet, so there is no price");
    expect(previewFacts({ ...full, extra_per_hour_cents: -150 })).toContain("Extra spend per hour: -$1.50");
  });
  it("every state prints no null, undefined or NaN, and no internal id", () => {
    const states = [full, { basis: "none" }, { basis: "seed", clear_minutes_old: NaN }, {}, { basis: "something_new", unpriced_items: undefined }];
    for (const s of states) for (const t of previewFacts(s)) expect(t, JSON.stringify(s)).not.toMatch(/undefined|null|NaN|_/);
    for (const v of [...Object.values(BASIS_TEXT), ...Object.values(SOURCE_TEXT), ...Object.values(LIM_COPY)]) expect(v).not.toMatch(/_|undefined|null/);
  });
});

describe("validation names the field", () => {
  it("builds at once: a whole number of 1 or more", () => {
    expect(parseCount(" 8 ")).toEqual({ value: 8 });
    expect(parseCount("2147483647")).toEqual({ value: 2147483647 });
    for (const bad of ["", "0", "-1", "2.5", "1e3", "abc", "2147483648"]) expect(parseCount(bad).error, bad).toMatch(/^Builds at once:/);
  });
  it("weekly limit and margin: non-negative, two decimals at most, inside the server's bounds", () => {
    expect(parseWeekly("40")).toEqual({ value: 40 });
    expect(parseWeekly("0")).toEqual({ value: 0 });
    expect(parseWeekly("12.34")).toEqual({ value: 12.34 });
    for (const bad of ["", "-5", "1.234", "x", "100000000"]) expect(parseWeekly(bad).error, bad).toMatch(/^Weekly auto-start limit:/);
    expect(parseMargin("20.5")).toEqual({ value: 20.5 });
    expect(parseMargin("500")).toEqual({ value: 500 });
    for (const bad of ["", "-1", "500.01", "1.005", "ten"]) expect(parseMargin(bad).error, bad).toMatch(/^Default margin:/);
  });
  it("a failed write shows the server's words for a 422 or 400 and a fixed sentence otherwise", () => {
    expect(limFailureText({ status: 422, message: "margin_pct has at most two decimals" })).toBe("margin_pct has at most two decimals");
    expect(limFailureText({ status: 403, message: "secret" })).toBe(LIM_COPY.forbidden);
    expect(limFailureText({ status: 500, message: "secret" })).toBe(LIM_COPY.failed);
    expect(limFailureText(null)).toBe(LIM_COPY.failed);
  });
});

// ---- S5h-3: these settings live on this one surface ----
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "test" || name === "e2e") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}
const SETTING_ROUTES = /build-concurrency|autostart-envelope|envelope-margin|\/discovery\b|"discovery"/;

describe("S5h-3: no other page renders or writes these settings", () => {
  const hits = sources(ROOT)
    .map((p) => ({ file: relative(ROOT, p), text: readFileSync(p, "utf8") }))
    .filter((f) => SETTING_ROUTES.test(f.text));

  it("only the Autonomy section names these routes; the pipeline app only reads the auto-start sentence", () => {
    expect(hits.map((f) => f.file).sort()).toEqual(["apps/pipeline/pipeline-actions.js", "apps/roles/roles-autonomy.js"]);
  });
  it("the pipeline app makes no write to any of them", () => {
    const pipeline = hits.find((f) => f.file === "apps/pipeline/pipeline-actions.js").text;
    const calls = [...pipeline.matchAll(/call\("(\w+)", "([^"]*(?:autostart-envelope|envelope-margin|build-concurrency|discovery)[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls).toEqual(["GET /api/v1/account/autostart-envelope"]);
    expect(pipeline).not.toMatch(/(?:PUT|POST)", "\/api\/v1\/account\/(?:autostart-envelope|envelope-margin|build-concurrency)/);
  });
  // The PUT surface of the view: each route pinned in full, and the literal method exactly four times (an indirect method would hide a call).
  const putSurface = (src) => ({
    routes: [...src.matchAll(/api\("PUT", (repoPath\(repoId, "[a-z/-]+"\)|[^,]+)/g)].map((m) => m[1]).sort(),
    literals: (src.match(/"PUT"/g) || []).length,
  });
  const EXPECTED_PUTS = ['ACCOUNT + "autostart-envelope"', 'ACCOUNT + "envelope-margin"', "base", 'repoPath(repoId, "discovery")'];
  const viewSource = () => readFileSync(join(ROOT, "apps", "roles", "roles-autonomy.js"), "utf8");

  it("the Autonomy view PUTs only to the four settings' routes, each named in full, through the literal method", () => {
    expect(putSurface(viewSource())).toEqual({ routes: EXPECTED_PUTS, literals: 4 });
  });
  it("mutation: retargeting the discovery PUT to the dial route is caught", () => {
    const mutated = viewSource().replace('api("PUT", repoPath(repoId, "discovery")', 'api("PUT", repoPath(repoId, "decision-settings/dial")');
    expect(mutated).not.toBe(viewSource());
    expect(putSurface(mutated).routes).not.toEqual(EXPECTED_PUTS);
  });
  it("mutation: an indirect method (const m = \"PUT\"; api(m, ...)) is caught", () => {
    const mutated = viewSource().replace('api("PUT", ACCOUNT + "envelope-margin"', 'api(METHOD, ACCOUNT + "envelope-margin"').replace("const ACCOUNT =", 'const METHOD = "PUT";\nconst ACCOUNT =');
    expect(mutated).not.toBe(viewSource());
    const surface = putSurface(mutated);
    expect(surface.routes.length === 4 && surface.literals === 4).toBe(false);
  });
});
