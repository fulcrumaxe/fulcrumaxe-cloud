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

/**
 * The runner-protocol package carries the push route and transport (it spawns git) under its `/planePush` subpath. Hosted code may not reach
 * them from the package root or the subpath: this flags a named import or re-export of a git-running export, any import of a planePush subpath,
 * and a star re-export of the root.
 */
const GIT_EXPORTS = ["routeAndPush", "createGitTransport", "assertSafeLocalConfig", "gitCommitSource", "PublicGitTransport"];
const PROTOCOL_STATEMENT = /\b(?:import|export)\b[^;]*?\bfrom\s*["'](@fulcrumaxe\/runner-protocol[^"']*)["']|\bimport\s*\(\s*["'](@fulcrumaxe\/runner-protocol[^"']*)["']\s*\)/g;

function protocolGitReach(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PROTOCOL_STATEMENT)) {
    const spec = (m[1] ?? m[2])!;
    if (/\/planePush|\/repoPairing/.test(spec)) found.push(`subpath ${spec}`);
    for (const name of GIT_EXPORTS) if (new RegExp(`\\b${name}\\b`).test(m[0])) found.push(`${name} from ${spec}`);
    if (spec === "@fulcrumaxe/runner-protocol" && /\bexport\s*\*|\bimport\s*\*\s*as\b/.test(m[0])) found.push(`namespace or star form from ${spec}`);
  }
  return found;
}

function allCloudSource(): string[] {
  return readdirSync(cloudSrc).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(cloudSrc, f));
}

function entries(): string[] {
  const dirs = readdirSync(runnerRoutes).filter((d) => d.startsWith("plane-push-") || d.startsWith("plane-merge-"));
  const files = dirs.flatMap((d) => readdirSync(path.join(runnerRoutes, d)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(runnerRoutes, d, f)));
  return [...files, path.join(cloudSrc, "planePush.ts"), path.join(cloudSrc, "planeMerge.ts")];
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
    expect(files).toEqual(expect.arrayContaining(["apps/web/app/api/runner/plane-push-pairing/handler.ts", "apps/web/app/api/runner/plane-push-pairing/route.ts", "apps/web/app/api/runner/plane-push-report/handler.ts", "apps/web/app/api/runner/plane-push-report/route.ts", "apps/web/app/api/runner/plane-push-token/handler.ts", "apps/web/app/api/runner/plane-push-token/route.ts", "packages/runner-cloud/src/planePush.ts", "apps/web/app/api/runner/plane-merge-claim/handler.ts", "apps/web/app/api/runner/plane-merge-verify/route.ts", "apps/web/app/api/runner/plane-merge-report/handler.ts", "packages/runner-cloud/src/planeMerge.ts"]));
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

  it("no runner-cloud source, and no route file the handlers reach, imports a git-running export from the runner protocol package", () => {
    const files = [...new Set([...allCloudSource(), ...closure(entries()).keys()])];
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.flatMap((f) => protocolGitReach(readFileSync(f, "utf8")).map((why) => `${path.relative(repoRoot, f)}: ${why}`));
    expect(offenders).toEqual([]);
  });

  // A relative import from a runner-cloud file OUTSIDE the route closure (a sibling module reaching across packages by path) is not followed by the closure
  // walk above, so the banned names and a `planePush/` path are looked for in every runner-cloud source file.
  const PLANE_PUSH_PATH = /planePush\//;

  it("no runner-cloud source file names a banned module or a planePush/ path, whether or not the routes reach it", () => {
    const files = allCloudSource();
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => BANNED.test(readFileSync(f, "utf8")) || PLANE_PUSH_PATH.test(readFileSync(f, "utf8"))).map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });

  it("control: the banned names and the planePush/ path fire on a cross-package relative import, and not on the sibling route module's own name", () => {
    const rel = (spec: string): string => ["import", "{ x }", "from", JSON.stringify(spec)].join(" ") + ";";
    expect(PLANE_PUSH_PATH.test(rel("../../runner-protocol/src/planePush/index.js"))).toBe(true);
    expect(BANNED.test(rel("../../runner-protocol/src/planePush/planePushRoute.js"))).toBe(true);
    expect(PLANE_PUSH_PATH.test(rel("./planePush.js"))).toBe(false);
    expect(BANNED.test(rel("./planePush.js"))).toBe(false);
  });

  it("control: the protocol-import check fires on the root, the subpath, a re-export and a dynamic import, and not on an ordinary protocol import", () => {
    const from = (names: string, spec: string): string => ["import", names, "from", JSON.stringify(spec)].join(" ") + ";";
    const root = ["@fulcrumaxe", "runner-protocol"].join("/");
    expect(protocolGitReach(from("{ routeAndPush }", root))).toEqual([`routeAndPush from ${root}`]);
    expect(protocolGitReach(from("{ type X, createGitTransport as t }", root))).toEqual([`createGitTransport from ${root}`]);
    expect(protocolGitReach(from("{ routeAndPush }", `${root}/planePush`))).toEqual([`subpath ${root}/planePush`, `routeAndPush from ${root}/planePush`]);
    expect(protocolGitReach(`export { createGitTransport } from ${JSON.stringify(root)};`)).toEqual([`createGitTransport from ${root}`]);
    expect(protocolGitReach(`export * from ${JSON.stringify(root)};`)).toEqual([`namespace or star form from ${root}`]);
    expect(protocolGitReach(`const m = await import(${JSON.stringify(`${root}/planePush`)});`)).toEqual([`subpath ${root}/planePush`]);
    expect(protocolGitReach(from("{ normalizeRepoPath, isKnownStreamJsonType }", root))).toEqual([]);
  });
});
