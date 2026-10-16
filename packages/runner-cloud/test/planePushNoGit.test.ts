import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#598 P1f-2 (C4 acceptance 12): the hosted side of the public push reads GitHub and writes rows; it never runs a clone, a fetch or a push.
 * So nothing the two routes reach may import the push route's git builder, its transport, or Node's process spawning. The check follows the
 * relative imports from each entry file (the handlers under apps/web and `planePush.ts`), not just the entry files themselves.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
const runnerRoutes = path.join(repoRoot, "apps", "web", "app", "api", "runner");
const cloudSrc = path.join(here, "..", "src");

const BANNED = /planePushGit|planePushTransport|planePushRoute|node:child_process|from\s+["']child_process["']|from\s+["']@fx\/pipeline|from\s+["']node:worker_threads["']/;

function entries(): string[] {
  const dirs = readdirSync(runnerRoutes).filter((d) => d.startsWith("plane-push-"));
  const files = dirs.flatMap((d) => readdirSync(path.join(runnerRoutes, d)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(runnerRoutes, d, f)));
  return [...files, path.join(cloudSrc, "planePush.ts")];
}

function resolveRelative(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  return null;
}

function closure(start: string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const m of text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const next = resolveRelative(file, m[1]!);
      // The handlers reach the web lib through a relative path; stop at the runner-cloud package's own source and the route files.
      if (next && (next.startsWith(cloudSrc) || next.startsWith(runnerRoutes))) walk(next);
    }
  };
  start.forEach(walk);
  return seen;
}

describe("the public-push routes never run git or a process (import graph)", () => {
  it("finds the three routes and the handlers module", () => {
    const files = entries().map((f) => path.relative(repoRoot, f));
    expect(files).toEqual(expect.arrayContaining(["apps/web/app/api/runner/plane-push-pairing/handler.ts", "apps/web/app/api/runner/plane-push-pairing/route.ts", "apps/web/app/api/runner/plane-push-report/handler.ts", "apps/web/app/api/runner/plane-push-report/route.ts", "apps/web/app/api/runner/plane-push-token/handler.ts", "apps/web/app/api/runner/plane-push-token/route.ts", "packages/runner-cloud/src/planePush.ts"]));
  });

  it("no entry file, and nothing it reaches inside the package, names the git builder, the transport, the push route, a child process or the pipeline", () => {
    const reached = closure(entries());
    expect(reached.size).toBeGreaterThan(4);
    const offenders = [...reached].filter(([, text]) => BANNED.test(text)).map(([file]) => path.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it("control: the check does fire on a file that imports the transport", () => {
    // Built from pieces so no source line reads as an import (the declared-imports scan reads string literals too, and this package must not declare the pipeline).
    const imp = (names: string, from: string): string => ["import", names, "from", JSON.stringify(from)].join(" ") + ";";
    expect(BANNED.test(imp("{ createGitTransport }", ["@fx", "pipeline/src/build/planePushTransport.js"].join("/")))).toBe(true);
    expect(BANNED.test(imp("{ spawn }", ["node", "child_process"].join(":")))).toBe(true);
    expect(BANNED.test(imp("{ x }", "./gitTicket.js"))).toBe(false);
  });
});
