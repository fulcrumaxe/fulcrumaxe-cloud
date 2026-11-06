import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D#600 CX-7 (R-600-1): no fix round resumes the build's session. This pins who still calls `resumeAgentRun`, so a new caller cannot slip in unnoticed:
 *   - checkFix.ts, the fix round after a failed approved check: it needs the failed run's own kept workspace, which a fresh session cannot recover (named exception);
 *   - fixLoop.ts, the inline dispatch of `recordReviewVerdict`: production runs it only in `deferred` mode, so it is unreachable there (named exception);
 *   - continuation.ts, the continuation after a limit: its own fresh-plus-checkpoint path (E4), not a fix round.
 */
const ROOT = join(__dirname, "../../..");
const SKIP = new Set(["node_modules", ".next", "dist", "_generated", "test", "tests", "archive"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}
const files = [...sources(join(ROOT, "packages")), ...sources(join(ROOT, "apps"))];
const text = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const code = (src: string): string => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const rel = (f: string): string => relative(ROOT, f);

describe("who resumes a session (D#600 CX-7)", () => {
  it("calls resumeAgentRun only from the fix loop's inline mode, the continuation and the web wiring of the check fix round", () => {
    const callers = files.filter((f) => /\bresumeAgentRun\(/.test(code(readFileSync(f, "utf8")))).map(rel).sort();
    expect(callers).toEqual([
      "apps/web/lib/advanceReview.ts",
      "packages/pipeline/src/build/continuation.ts",
      "packages/pipeline/src/build/fixLoop.ts",
      "packages/pipeline/src/build/resumeAgentRun.ts",
    ]);
  });

  it("in the worker, only the check fix round uses the review port's resume; the review fix start never does", () => {
    const users = files.filter((f) => rel(f).startsWith("packages/worker/src/") && /\b(review\.resume|deps\.resume|gatedResume)\b/.test(code(readFileSync(f, "utf8")))).map(rel).sort();
    expect(users).toEqual(["packages/worker/src/advance.ts", "packages/worker/src/checkFix.ts"]);
    const advance = code(text("packages/worker/src/advance.ts"));
    // advance.ts hands the port to the check fix round, once, and nowhere else.
    expect(advance.match(/review\.resume/g)).toHaveLength(1);
    expect(advance).toMatch(/startCheckFixRound\(\{[^}]*resume: gatedResume\(review\.resume\)/);
    const start = advance.slice(advance.indexOf("async function startFix("), advance.indexOf("async function advanceLightSpec("));
    expect(start).not.toMatch(/\bresume\b\s*\(/);
    expect(start).not.toMatch(/gatedResume/);
    expect(start).toContain("starter!.start(");
  });
});
