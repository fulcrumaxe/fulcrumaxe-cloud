import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..", "..");
const SKIP = new Set(["node_modules", ".next", "dist", "_generated", "public", "test", "e2e", "archive"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(path.relative(ROOT, full));
  }
  return out;
}

/**
 * D#2 RLR-5: a run is read by a slice follower only if something starts one, and the sandbox target hands a run over only when the run says `slice: true`. That is
 * safe by construction when the only code that sets it is the run starter, which starts the follower for every run it starts, and the one copy of the flag from the
 * start input to the run. A new caller that sets it fails here and has to answer for its follower.
 */
describe("who may set the slice opt-in", () => {
  it("only the run starter sets it, and startAgentRun carries it through", () => {
    const sets = [...walk(path.join(ROOT, "packages")), ...walk(path.join(ROOT, "apps"))].filter((f) => /\bslice:\s*true\b/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(sets.sort()).toEqual(["packages/runner/src/startAgentRun.ts", "packages/worker/src/starter.ts"]);
  });

  it("the starter that sets it starts a follower for every run it starts, after the start and before it returns", () => {
    const src = readFileSync(path.join(ROOT, "packages/worker/src/starter.ts"), "utf8");
    const start = src.indexOf("slice: true");
    const follow = src.indexOf("await deps.follow(", start);
    expect(start).toBeGreaterThan(0);
    expect(follow).toBeGreaterThan(start);
    // Between the start and the follower there is only the refusal / queued / idempotency handling, never an early return of a running run.
    const between = src.slice(start, follow);
    expect(between).not.toMatch(/return \{ runId: started\.id \};\s*\n\s*\}\s*\n\s*\n\s*logEvent\("run\.started"/);
    expect(src.slice(follow)).toMatch(/catch \(err\)[\s\S]*cancel\(buildExecutionRun/);
  });
});
