import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { FULL_CLONES_PER_REPO_PER_DAY, RUNNER_GIT_DENIALS, createRunnerGitResolver, type RunnerGitRequest } from "../src/runnerGitResolver.js";
import { captureReports } from "./helpers/captureReports.js";

const REQUEST: RunnerGitRequest = {
  runnerId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  generation: 2,
  repoId: "44444444-4444-4444-8444-444444444444",
  fullClone: true,
};

const OK_ROW = { verdict: "ok", role: "executor", product: "team", gh_owner: "acme", gh_name: "widgets", gh_installation_id: "4242", app_kind: "team" };
const NONE = { role: null, product: null, gh_owner: null, gh_name: null, gh_installation_id: null, app_kind: null };

const poolAnswering = (rows: unknown[] | Error) => {
  const query = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return { rows };
  });
  return { pool: { query } as unknown as Pool, query };
};

describe("createRunnerGitResolver (D#6 R5a-2a)", () => {
  it("asks the database function with the six values in order and nothing else", async () => {
    const { pool, query } = poolAnswering([OK_ROW]);
    await createRunnerGitResolver(pool)(REQUEST);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("public.resolve_runner_git_request($1, $2, $3, $4, $5, $6)");
    expect(params).toEqual([REQUEST.runnerId, REQUEST.accountId, REQUEST.runId, 2, REQUEST.repoId, true]);
  });

  it("maps an ok row to the grant, with the installation id as a number", async () => {
    const { pool } = poolAnswering([OK_ROW]);
    expect(await createRunnerGitResolver(pool)(REQUEST)).toEqual({
      verdict: "ok", role: "executor", product: "team", installationId: 4242, appKind: "team", owner: "acme", repo: "widgets",
    });
  });

  it.each(RUNNER_GIT_DENIALS)("passes the %s verdict through, with no grant fields", async (verdict) => {
    const { pool } = poolAnswering([{ verdict, ...NONE }]);
    expect(await createRunnerGitResolver(pool)(REQUEST)).toEqual({ verdict });
  });

  it.each([
    ["no row", []],
    ["two rows", [OK_ROW, OK_ROW]],
    ["an unknown verdict", [{ ...OK_ROW, verdict: "allowed" }]],
    ["an ok row without an owner", [{ ...OK_ROW, gh_owner: null }]],
    ["an ok row without a name", [{ ...OK_ROW, gh_name: null }]],
    ["an ok row without a role", [{ ...OK_ROW, role: null }]],
    ["an ok row with an unrecognised product", [{ ...OK_ROW, product: "other" }]],
    ["an ok row with a zero installation", [{ ...OK_ROW, gh_installation_id: "0" }]],
    ["an ok row with an installation beyond the safe integers", [{ ...OK_ROW, gh_installation_id: "9007199254740993" }]],
    ["an ok row with no installation", [{ ...OK_ROW, gh_installation_id: null }]],
  ])("answers null for %s", async (_label, rows) => {
    captureReports();
    expect(await createRunnerGitResolver(poolAnswering(rows).pool)(REQUEST)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31, Number.MAX_SAFE_INTEGER + 1])("answers null for generation %s without asking the database", async (generation) => {
    const { pool, query } = poolAnswering([OK_ROW]);
    expect(await createRunnerGitResolver(pool)({ ...REQUEST, generation })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("answers null on a database error and reports a coded class, never the error's text", async () => {
    const reports = captureReports();
    const secret = ["gh", "s_", "x".repeat(36)].join("");
    const err = Object.assign(new Error(`connection to ${secret} failed for acme/widgets`), { code: "57P01" });
    expect(await createRunnerGitResolver(poolAnswering(err).pool)(REQUEST)).toBeNull();
    const out = reports.everything();
    expect(out).toContain("57P01");
    expect(out).toContain("github.runner_git_resolve");
    expect(out).not.toContain(secret);
    expect(out).not.toContain("acme/widgets");
  });

  it("answers null for a database error of any shape, including one with no code", async () => {
    captureReports();
    expect(await createRunnerGitResolver(poolAnswering(new Error("boom")).pool)(REQUEST)).toBeNull();
  });
});

describe("the TypeScript side keeps step with migration 0765", () => {
  const sql = readFileSync(path.join(__dirname, "../../db/migrations/0765_runner_git_path_a.sql"), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  it("FULL_CLONES_PER_REPO_PER_DAY is the constant inside the function and the table's upper bound", () => {
    expect(FULL_CLONES_PER_REPO_PER_DAY).toBe(3);
    expect(sql).toMatch(new RegExp(`WHERE c\\.full_clones < ${FULL_CLONES_PER_REPO_PER_DAY}\\b`));
    expect(sql).toMatch(new RegExp(`CHECK \\(full_clones BETWEEN 1 AND ${FULL_CLONES_PER_REPO_PER_DAY}\\)`));
    expect(sql).not.toMatch(/p_(limit|max|window)/);
  });

  it("RUNNER_GIT_DENIALS plus ok are exactly the verdicts the function can answer", () => {
    const answered = [...sql.matchAll(/SELECT '([a-z_]+)'::text/g)].map((m) => m[1]);
    expect([...new Set(answered)].sort()).toEqual([...RUNNER_GIT_DENIALS, "ok"].sort());
  });
});
