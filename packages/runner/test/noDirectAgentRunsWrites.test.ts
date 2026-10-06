import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.join(__dirname, "..", "..");

/**
 * D#2 H09c (correction C37 criterion 5): no SQL text in any
 * `packages/** /src` file INSERTs into or UPDATEs `agent_runs` directly.
 * Every write goes through the agent_run_writer-only functions
 * (`agent_run_create`, `agent_run_set_status`, 0642). The one exception is
 * an UPDATE whose SET list names only the pure metering columns app_user is
 * still allowed to write.
 *
 * This is a lint, not the control: a write that slips past it still fails
 * 42501 at runtime, because the writer login holds only app_user's table
 * privileges. It scans each package's src directory only (not scripts/,
 * apps/ or sites/) and cannot see SQL assembled from split string literals.
 */
const METERING_COLUMNS = new Set(["tokens_in", "tokens_out", "usd"]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|sql)$/.test(entry)) out.push(full);
  }
  return out;
}

function allPackageSrcFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = path.join(PACKAGES_DIR, pkg, "src");
    try {
      if (statSync(src).isDirectory()) files.push(...listSourceFiles(src));
    } catch {
      // package without a src/ directory
    }
  }
  return files;
}

interface Violation {
  file: string;
  text: string;
}

export function findDirectAgentRunsWrites(source: string, file = "<inline>"): Violation[] {
  const code = stripComments(source);
  const found: Violation[] = [];
  // Optional quoted schema ("public"."agent_runs"), quoted table.
  for (const m of code.matchAll(/\b(INSERT\s+INTO|MERGE\s+INTO)\s+(?:"?public"?\.)?"?agent_runs"?\b/gi)) {
    found.push({ file, text: m[0] });
  }
  // A table name interpolated into a write (`INSERT INTO ${table}`) cannot be
  // checked statically, so it is flagged outright.
  for (const m of code.matchAll(/\b(?:INSERT\s+INTO|MERGE\s+INTO|UPDATE)\s+(?:ONLY\s+)?\$\{/gi)) {
    found.push({ file, text: m[0] });
  }
  // Optional `AS`, optional (quoted) alias between the table and SET.
  for (const m of code.matchAll(
    /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?agent_runs"?\s+(?:AS\s+)?(?:"?\w+"?\s+)?SET\s+([\s\S]*?)(?:\bWHERE\b|`|"|'|;|$)/gi,
  )) {
    const setList = m[1] ?? "";
    // Column names on the left of each `=` at the top level of the SET list.
    const columns = [...setList.matchAll(/(?:^|,)\s*"?([a-z_]+)"?\s*=/gi)].map((c) => c[1]!.toLowerCase());
    const onlyMetering = columns.length > 0 && columns.every((c) => METERING_COLUMNS.has(c));
    if (!onlyMetering) found.push({ file, text: m[0].slice(0, 120) });
  }
  return found;
}

describe("no direct agent_runs writes in packages/**/src (H09c, C37 criterion 5)", () => {
  it("finds a source tree to scan (the scan is not vacuous)", () => {
    const files = allPackageSrcFiles();
    expect(files.some((f) => f.endsWith(path.join("runner", "src", "runStatusWriter.ts")))).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });

  it("no INSERT INTO / MERGE INTO agent_runs, and no UPDATE agent_runs outside the metering allowlist", () => {
    const violations = allPackageSrcFiles().flatMap((f) =>
      findDirectAgentRunsWrites(readFileSync(f, "utf8"), path.relative(PACKAGES_DIR, f)),
    );
    expect(violations).toEqual([]);
  });

  it("the scanner itself flags the writes it must (a scan that flags nothing proves nothing)", () => {
    expect(findDirectAgentRunsWrites("client.query(`INSERT INTO agent_runs (id) VALUES ($1)`)")).toHaveLength(1);
    expect(findDirectAgentRunsWrites("client.query(`UPDATE agent_runs SET status = $1 WHERE id = $2`)")).toHaveLength(1);
    expect(findDirectAgentRunsWrites("client.query(`UPDATE agent_runs SET tokens_in = 1, status = 'x' WHERE id = $2`)")).toHaveLength(1);
    expect(findDirectAgentRunsWrites("client.query(`UPDATE public.agent_runs ar SET envelope = $1`)")).toHaveLength(1);
    expect(findDirectAgentRunsWrites("client.query(`MERGE INTO agent_runs t USING x ON true`)")).toHaveLength(1);
    // Evasions the first version of this scanner missed.
    expect(findDirectAgentRunsWrites("client.query(`UPDATE agent_runs AS ar SET status = $1`)")).toHaveLength(1);
    expect(findDirectAgentRunsWrites('client.query(`UPDATE "public"."agent_runs" "ar" SET envelope = $1`)')).toHaveLength(1);
    expect(findDirectAgentRunsWrites('client.query(`INSERT INTO "public"."agent_runs" (id) VALUES ($1)`)')).toHaveLength(1);
    expect(findDirectAgentRunsWrites("client.query(`INSERT INTO ${table} (id) VALUES ($1)`)")).toHaveLength(1);
    expect(findDirectAgentRunsWrites("client.query(`UPDATE ${table} SET status = $1`)")).toHaveLength(1);
  });

  it("the scanner lets a metering-only UPDATE and comment text through", () => {
    expect(findDirectAgentRunsWrites("client.query(`UPDATE agent_runs SET tokens_in = $1, usd = $2 WHERE id = $3`)")).toEqual([]);
    expect(findDirectAgentRunsWrites("client.query(`UPDATE agent_runs AS ar SET tokens_in = $1 WHERE id = $3`)")).toEqual([]);
    expect(findDirectAgentRunsWrites("// UPDATE agent_runs SET status = 'x'\n/* INSERT INTO agent_runs */")).toEqual([]);
  });

  it("the writer calls the SECURITY DEFINER functions, and packages/runner/src reads no process.env", () => {
    const writer = readFileSync(path.join(PACKAGES_DIR, "runner", "src", "runStatusWriter.ts"), "utf8");
    expect(writer).toMatch(/agent_run_create\(/);
    expect(writer).toMatch(/agent_run_set_status\(/);
    const runnerSrc = listSourceFiles(path.join(PACKAGES_DIR, "runner", "src"));
    for (const f of runnerSrc) {
      expect(stripComments(readFileSync(f, "utf8")), f).not.toMatch(/process\.env/);
    }
  });
});
