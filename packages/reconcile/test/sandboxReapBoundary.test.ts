import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#2 SANDBOX-REAPER, C82 criterion 21 (the reconcile side): the sweeps reach the sandbox reaper only through the worker facade's
 * plain data, so nothing under the reconcile package or its cron route may import a pool, the worker's login, or the runner's
 * sandbox port. (The reconcile package's own platform_ops pool is not the worker's and is not what this forbids.) A grep over imports.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = ["packages/reconcile/src", "apps/web/app/api/cron/reconcile"];
const FORBIDDEN_MODULE = [/^@fx\/(runner|worker)(\/|$)/, /(^|\/)pools(\.js)?$/, /(^|\/)(runner|worker)\/src\//];
const FORBIDDEN_NAME = /\b(WorkerPools|createWorkerPools|runnerPool|platformOpsPool|SandboxPort|SandboxHandle|createVercelSandboxPort|BuiltWorker|buildWorker|createWorker)\b/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => (statSync(path.join(dir, e)).isDirectory() ? sourceFiles(path.join(dir, e)) : /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [path.join(dir, e)] : []));

function violations(files: Array<{ file: string; source: string }>): string[] {
  return files.flatMap(({ file, source }) => {
    const imports = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']|import\s*\(?\s*["']([^"']+)["']/g)].map((m) => ({ clause: m[1] ?? "", module: m[2] ?? m[3]! }));
    return imports.flatMap(({ module, clause }) => [...(FORBIDDEN_MODULE.some((re) => re.test(module)) ? [`${file}: imports ${module}`] : []), ...(FORBIDDEN_NAME.test(clause) ? [`${file}: imports ${clause.trim()}`] : [])]);
  });
}

describe("criterion 21: the reconcile side imports no pool, login or port", () => {
  const files = SCANNED.flatMap((d) => sourceFiles(path.join(ROOT, d))).map((file) => ({ file: path.relative(ROOT, file), source: readFileSync(file, "utf8") }));

  it("scans real files and finds no forbidden import", () => {
    expect(files.some((f) => f.file === "apps/web/app/api/cron/reconcile/handler.ts")).toBe(true);
    expect(violations(files)).toEqual([]);
  });

  it("would find one: each forbidden shape is caught, and ordinary imports are not", () => {
    for (const source of [`import { x } from "@fx/runner";`, `import type { W } from "@fx/${"worker"}/src/compositionRoot";`, `import { p } from "../../${"worker"}/src/pools.js";`, `import type { SandboxPort } from "./port";`, `export type { SandboxHandle } from "./port";`, `const m = await import("../pools.js");`]) {
      expect(violations([{ file: "x.ts", source }]), source).not.toEqual([]);
    }
    expect(violations([{ file: "x.ts", source: `import { Pool } from "pg";\nimport { reportError } from "@fx/telemetry";` }])).toEqual([]);
  });
});
