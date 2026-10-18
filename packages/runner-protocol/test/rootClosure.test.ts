import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#598 P1f-3a follow-up: the package root (`src/index.ts`) is imported by the cloud, whose hosted routes must never run a process. The public-push route
 * and its transport run the version-control tool, and live under `src/planePush/`, reachable only through the `/planePush` subpath. So nothing the root
 * reaches, following every relative import, re-export and dynamic import, may be a file in `planePush/` or name Node's process spawning.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
const PROCESS_SPAWNING = /^(?:node:)?(?:child_process|worker_threads|cluster)$/;

function resolveRelative(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  return null;
}

/** Every file reachable from `entry` by relative specifiers, and every problem found on the way. */
function reach(entry: string, root: string = srcDir): { files: string[]; problems: string[] } {
  const planePushDir = path.join(root, "planePush");
  const seen = new Set<string>();
  const problems: string[] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (PROCESS_SPAWNING.test(spec)) problems.push(`${path.relative(root, file)} imports ${spec}`);
      if (!spec.startsWith(".")) continue;
      const next = resolveRelative(file, spec);
      if (next === null) {
        problems.push(`${path.relative(root, file)} imports ${spec}, which does not resolve to a source file`);
        continue;
      }
      if (next === planePushDir || next.startsWith(planePushDir + path.sep)) problems.push(`${path.relative(root, file)} reaches ${path.relative(root, next)}`);
      walk(next);
    }
  };
  walk(entry);
  return { files: [...seen], problems };
}

describe("the package root never reaches the public-push route or a process", () => {
  it("src/index.ts and every file it reaches by relative imports stay out of planePush/ and import no process-spawning module", () => {
    const { files, problems } = reach(path.join(srcDir, "index.ts"));
    expect(files.length).toBeGreaterThan(8);
    expect(problems).toEqual([]);
  });

  it("control: the walk finds a planePush/ file, a child_process import and a dynamic import, through a re-export", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rootclosure-"));
    try {
      mkdirSync(path.join(root, "planePush"));
      writeFileSync(path.join(root, "a.ts"), 'export * from "./b.js";');
      writeFileSync(path.join(root, "b.ts"), 'import { x } from "./planePush/inner.js"; const m = await import("./c.js");');
      writeFileSync(path.join(root, "c.ts"), 'import { spawn } from "node:child_process";');
      writeFileSync(path.join(root, "planePush", "inner.ts"), "export const x = 1;");
      const found = reach(path.join(root, "a.ts"), root);
      expect(found.files.map((f) => path.relative(root, f)).sort()).toEqual(["a.ts", "b.ts", "c.ts", "planePush/inner.ts"]);
      expect(found.problems.sort()).toEqual(["b.ts reaches planePush/inner.ts", "c.ts imports node:child_process"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the planePush/ files are not exported by the root's index", () => {
    expect(readFileSync(path.join(srcDir, "index.ts"), "utf8")).not.toMatch(/planePush\//);
  });
});
