import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import { askPolicyFor } from "../src/decisionIntake.js";

const PACKAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("D#7 DP4b-2 R-7-DP4b-8: the timeout a park freezes", () => {
  const allows = CATALOGUE.filter((e) => e.timeoutOutcomes.includes("proceed_recommended"));
  const excludes = CATALOGUE.filter((e) => e.class !== "automated_with_monitoring" && !e.timeoutOutcomes.includes("proceed_recommended"));

  it("never passes proceed_recommended for an entry whose timeoutOutcomes excludes it, whatever the settings resolved", () => {
    expect(excludes.length).toBeGreaterThan(0);
    for (const entry of excludes) {
      expect(askPolicyFor(entry, { answerWindowMinutes: 60, timeoutOutcome: "proceed_recommended" }), entry.id).toEqual({ answerWindowMinutes: 60, onTimeout: "stop_and_flag" });
    }
  });

  it("passes it through where the entry allows it, and keeps the window; a stop stays a stop", () => {
    expect(allows.length).toBeGreaterThan(0);
    for (const entry of allows) {
      expect(askPolicyFor(entry, { answerWindowMinutes: 90, timeoutOutcome: "proceed_recommended" })).toEqual({ answerWindowMinutes: 90, onTimeout: "proceed_recommended" });
      expect(askPolicyFor(entry, { answerWindowMinutes: 90, timeoutOutcome: "stop_and_flag" })).toEqual({ answerWindowMinutes: 90, onTimeout: "stop_and_flag" });
    }
  });

  it("the class-2 start entries are stop-and-flag only, so no card can reach a proceed through them", () => {
    for (const id of ["start_work_small", "start_work_bug", "start_work_doc"]) {
      expect(CATALOGUE.find((e) => e.id === id)!.timeoutOutcomes).toEqual(["stop_and_flag"]);
    }
  });
});

/** Source files under `dir` (recursive), `.ts` and `.md` only, skipping dependencies and tests. */
function sources(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// An import, re-export, dynamic import or require of the policy package, or of the worker's decision modules.
const POLICY = /(?:from|import\(|require\()\s*["'](?:@fx\/decisions|@fx\/worker|[^"']*decision(?:Intake|Snapshot))/;

describe("D#7 DP4 criterion 3 and R-7-DP4b-4: the policy does not reach the layers that enforce the invariants", () => {
  const guarded: Array<[string, string[]]> = [
    ["packages/roles/src", sources(path.join(PACKAGES, "roles", "src"), [".ts"])],
    ["packages/gh-policy/src", sources(path.join(PACKAGES, "gh-policy", "src"), [".ts"])],
    ["packages/trust/src", sources(path.join(PACKAGES, "trust", "src"), [".ts"])],
    ["packages/db/src/withTenant.ts", [path.join(PACKAGES, "db", "src", "withTenant.ts")]],
  ];

  it.each(guarded)("nothing in %s imports @fx/decisions or the decision call site", (_name, files) => {
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => POLICY.test(readFileSync(f, "utf8"))).map((f) => path.relative(PACKAGES, f));
    expect(offenders).toEqual([]);
  });

  it("the role cards never name the policy package either", () => {
    const cards = [...sources(path.join(PACKAGES, "roles", "cards"), [".md"]), ...sources(path.join(PACKAGES, "roles", "cards-product"), [".md"])];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((f) => /@fx\/decisions/.test(readFileSync(f, "utf8"))).map((f) => path.relative(PACKAGES, f))).toEqual([]);
  });

  it("the check is not vacuous: its pattern matches every spelling of an import of the policy", () => {
    for (const line of [
      'import { decide } from "@fx/decisions";',
      'export { decide } from "@fx/decisions";',
      'const m = await import("@fx/decisions");',
      'const m = require("@fx/decisions");',
      'import { createDecisionIntake } from "@fx/worker/src/decisionIntake.js";',
      'import { x } from "../../worker/src/decisionSnapshot.js";',
    ]) {
      expect(POLICY.test(line), line).toBe(true);
    }
    expect(POLICY.test('import { x } from "@fx/runner";')).toBe(false);
  });
});
