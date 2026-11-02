import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D#519 MQ4-e2-b: `app_user` holds table-level UPDATE on `plane_merge_orders`, so the database cannot tell the report route from other tenant-scoped code. This scan backs the claim
 * that the four `conflict_*` columns are written by one statement only: the store's `end()` in packages/worker/src/runnerPlaneMerge.ts (the report route reaches it through `finish`).
 */
const ROOT = join(__dirname, "../../..");
const WRITER = "packages/worker/src/runnerPlaneMerge.ts";
const SKIP = new Set(["node_modules", ".next", "dist", "_generated", "test", "tests", "archive"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mjs|sql)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

// An assignment in a SET list, or a column named in an INSERT into the table. A read (SELECT ... conflict_verdict, ...) is neither.
const WRITE = /conflict_(verdict|base_sha|base_ref|files)\s*=\s*[$:(']|INSERT INTO plane_merge_orders[^;`]*conflict_(verdict|base_sha|base_ref|files)/;

describe("the conflict columns of plane_merge_orders have one writer", () => {
  const files = [...sources(join(ROOT, "packages")), ...sources(join(ROOT, "apps"))].filter((f) => !f.includes("/migrations/"));

  it("only the store's end() assigns them, in one statement", () => {
    const writers = files.filter((f) => readFileSync(f, "utf8").includes("plane_merge_orders") && WRITE.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(writers).toEqual([WRITER]);
    const text = readFileSync(join(ROOT, WRITER), "utf8");
    expect(text.match(/conflict_verdict\s*=\s*\$/g)).toHaveLength(1);
  });
});
