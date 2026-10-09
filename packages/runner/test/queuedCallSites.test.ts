import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#6 C29, test 9. A caller of `startAgentRun` or `resumeAgentRun` handles a run the runner target queued in one of two
 * named ways: `failClosedOnQueued` (the default: cancel it and throw) or `acceptQueuedRunnerRun` (leave it pending for a runner
 * to claim, for a caller whose wait is a status poll that credits queued time). This pins both sets by file, so a new caller
 * fails here until somebody adds it on purpose and says which way it goes.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !path.includes(`${sep}test${sep}`)) yield path;
  }
}

/** Calls of `name(` in code lines (comments and the declaration, which has a type parameter list, are not calls). */
function callSites(name: string): Record<string, number> {
  const found: Record<string, number> = {};
  const roots = [join(ROOT, "apps"), ...readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "src"))];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = [...sources(root)];
    } catch {
      continue; // fx-swallow-ok: a package with no src directory has no call sites
    }
    for (const file of entries) {
      const n = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .reduce((sum, line) => sum + (line.match(new RegExp(`\\b${name}\\(`, "g"))?.length ?? 0), 0);
      if (n > 0) found[relative(ROOT, file).split(sep).join("/")] = n;
    }
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

describe("callers of a queued runner run (D#6 C29)", () => {
  it("failClosedOnQueued: exactly the callers that wait on a hook or on a run's end, the preview starter's refuse branch, and the backstop in acceptQueuedRunnerRun", () => {
    expect(callSites("failClosedOnQueued")).toEqual({
      "packages/pipeline/src/build/continuation.ts": 1,
      "packages/pipeline/src/build/fixLoop.ts": 1,
      "packages/pipeline/src/build/stageMachine.ts": 2,
      "packages/pipeline/src/plan/sandboxPanelRunner.ts": 1,
      "packages/runner/src/startAgentRun.ts": 1,
      "packages/runner/src/workflows/agentRun.ts": 1,
      "packages/worker/src/starter.ts": 1,
    });
  });

  it("the composition root builds the preview's starter with refuse and the advance module's with accept", () => {
    const source = readFileSync(join(ROOT, "packages/worker/src/compositionRoot.ts"), "utf8");
    expect(source).toMatch(/const previewStarter = [^\n]*queued: "refuse"/);
    expect(source).toMatch(/const advanceStarter = [^\n]*queued: "accept"/);
    expect(source).toMatch(/starter: previewStarter,/);
    expect(source).toMatch(/createAdvanceModule\(pools\.runnerPool, \{ starter: advanceStarter,/);
    expect([...source.matchAll(/queued: "(accept|refuse)"/g)]).toHaveLength(2);
  });

  it("acceptQueuedRunnerRun: the advance starter's accept branch, the fix-round resume and retry, nobody else", () => {
    expect(callSites("acceptQueuedRunnerRun")).toEqual({
      "packages/worker/src/advance.ts": 1,
      "packages/worker/src/retry.ts": 1,
      "packages/worker/src/starter.ts": 1,
    });
  });
});
