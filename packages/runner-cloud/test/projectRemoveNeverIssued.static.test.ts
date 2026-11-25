import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#845 ON-16a1: a project removal runs on the session jobs (`engine_session_stop {reason: "remove"}`, then `engine_session_delete`), so the `project_remove` machine job kind stays in the
 * protocol and in migration 1053's CHECK but is never issued. This scan reads every source file under `packages/*\/src` and `apps/*` and refuses any `"project_remove"` string literal
 * (the way a job would be signed or a row inserted) outside the protocol's own `machineJobs.ts`, which defines the kind. Comments are not code and are skipped.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);
const ALLOWED = new Set([path.join("packages", "runner-protocol", "src", "machineJobs.ts")]);
const LITERAL = /["'`]project_remove["'`]/;

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.isFile() && EXTENSIONS.has(path.extname(e.name))) out.push(path.join(dir, e.name));
  }
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(path.join(root, "packages"), { withFileTypes: true })) if (pkg.isDirectory()) walk(path.join(root, "packages", pkg.name, "src"), out);
  walk(path.join(root, "apps"), out);
  return out;
}

/** The text without its comments (line, block, and SQL line comments), so a mention in prose is not a finding. */
const code = (text: string, sql: boolean): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(sql ? /--[^\n]*/g : /(^|[^:"'`])\/\/[^\n]*/g, "$1");

function issuers(root: string): string[] {
  return sourceFiles(root)
    .filter((file) => !ALLOWED.has(path.relative(root, file)))
    .filter((file) => LITERAL.test(code(readFileSync(file, "utf8"), file.endsWith(".sql"))))
    .map((file) => path.relative(root, file));
}

describe("project_remove is never issued", () => {
  it("no source file outside the protocol's machineJobs.ts names the kind as a literal", () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(500); // the scan really reads the tree
    expect(issuers(ROOT)).toEqual([]);
  });

  it("finds a signed job, a row insert and a SQL literal, and ignores a comment", () => {
    const probe = (text: string, sql = false): boolean => LITERAL.test(code(text, sql));
    expect(probe('signer.signMachineJob({ v: 1, kind: "project_remove", args: {} })')).toBe(true);
    expect(probe("await client.query(\"SELECT machine_job_issue($1, $2, $3, NULL, 'project_remove', $4, $5, $6)\")")).toBe(true);
    expect(probe("INSERT INTO machine_jobs (kind) VALUES ('project_remove');", true)).toBe(true);
    expect(probe("const k = `project_remove`;")).toBe(true);
    expect(probe("// the kind `project_remove` stays in the protocol\nconst a = 1;")).toBe(false);
    expect(probe("/** `project_remove` is never issued */\nconst a = 1;")).toBe(false);
    expect(probe("-- 'project_remove' stays in the CHECK\nSELECT 1;", true)).toBe(false);
  });
});
