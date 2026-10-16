import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPublishTargetResolver } from "../src/publishTargetResolver.js";
import { captureReports } from "./helpers/captureReports.js";

const BRANCH = "fx/p-123e4567-e89b-42d3-a456-426614174000";
const OK_ROW = { code_repo: "acme/widgets-public", branch: BRANCH };

const poolAnswering = (rows: unknown[] | Error) => {
  const query = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return { rows };
  });
  return { pool: { query } as unknown as Pool, query };
};

describe("createPublishTargetResolver (D#598 P1f-4a)", () => {
  it("asks the database function with the sandbox name as the only value", async () => {
    const { pool, query } = poolAnswering([OK_ROW]);
    await createPublishTargetResolver(pool)("pp-abc");
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("public.resolve_plane_publish_target($1)");
    expect(params).toEqual(["pp-abc"]);
  });

  it("maps the one row to the repository and the branch", async () => {
    const { pool } = poolAnswering([OK_ROW]);
    expect(await createPublishTargetResolver(pool)("pp-abc")).toEqual({ codeRepo: "acme/widgets-public", branch: BRANCH });
  });

  it.each([
    ["no row", []],
    ["two rows", [OK_ROW, OK_ROW]],
    ["a null repository", [{ ...OK_ROW, code_repo: null }]],
    ["a null branch", [{ ...OK_ROW, branch: null }]],
    ["a repository without an owner", [{ ...OK_ROW, code_repo: "widgets" }]],
    ["a repository with a path in it", [{ ...OK_ROW, code_repo: "acme/widgets/extra" }]],
    ["a repository named dot-dot", [{ ...OK_ROW, code_repo: "acme/.." }]],
    ["a repository with a space", [{ ...OK_ROW, code_repo: "acme/wid gets" }]],
    ["a branch that is not fx/p-<uuid>", [{ ...OK_ROW, branch: "main" }]],
    ["a run branch", [{ ...OK_ROW, branch: "fx/123e4567-e89b-42d3-a456-426614174000-g1" }]],
    ["a branch with a suffix", [{ ...OK_ROW, branch: `${BRANCH}/x` }]],
    ["a branch with upper-case hex", [{ ...OK_ROW, branch: "fx/p-123E4567-E89B-42D3-A456-426614174000" }]],
  ])("answers null for %s", async (_label, rows) => {
    const { pool } = poolAnswering(rows);
    expect(await createPublishTargetResolver(pool)("pp-abc")).toBeNull();
  });

  it("answers null for an empty or non-string name without asking the database", async () => {
    const { pool, query } = poolAnswering([OK_ROW]);
    const resolve = createPublishTargetResolver(pool);
    expect(await resolve("")).toBeNull();
    expect(await resolve(undefined as unknown as string)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("answers null on a database error and reports its class only, never its text", async () => {
    const reports = captureReports();
    const { pool } = poolAnswering(Object.assign(new Error('password authentication failed for user "ghproxy" FAKE-4a-db-password'), { code: "28P01" }));
    expect(await createPublishTargetResolver(pool)("pp-abc")).toBeNull();
    expect(reports.classes).toEqual([{ service: "test", route: "/", stage: "github.plane_publish_target_resolve", code: "28P01" }]);
    expect(reports.everything()).not.toMatch(/FAKE-4a-db-password|ghproxy/);
  });
});
