import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { createRunnerCloneBudget, RUNNER_UPLOAD_PACK_DAILY_BYTES_PER_REPO, secondsUntilUtcMidnight } from "../src/runnerCloneBudget.js";
import { captureReports } from "./helpers/captureReports.js";
import { ensureGhProxyTestLogin } from "./helpers/ghProxyLogin.js";
import { seedAccountWithRepo, type SeedRefs } from "./helpers/seed.js";

/** D#6 R5a-2c: createRunnerCloneBudget against the real migration 0766 function, on the real narrow gh-proxy login. */
describe("createRunnerCloneBudget on the narrow login (0766)", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    admin = await adminPool.connect();
    proxyPool = createPool(await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!));
    refs = await seedAccountWithRepo(admin, 6_464);
  });
  afterAll(async () => {
    admin.release();
    await proxyPool.end();
    await adminPool.end();
  });

  it("pins the TS allowance to the constant inside the database function", () => {
    const sql = readFileSync(path.join(__dirname, "../../db/migrations/0766_runner_git_upload_pack_bytes.sql"), "utf8");
    const m = /v_budget\s+CONSTANT\s+bigint\s*:=\s*(\d+);/.exec(sql);
    expect(Number(m?.[1])).toBe(RUNNER_UPLOAD_PACK_DAILY_BYTES_PER_REPO);
  });

  it("is open, counts what is recorded, and is spent once the day's bytes reach the allowance", async () => {
    const budget = createRunnerCloneBudget(proxyPool);
    expect(await budget.isSpent(refs.repoId)).toBe(false);
    expect(await budget.record(refs.repoId, RUNNER_UPLOAD_PACK_DAILY_BYTES_PER_REPO - 1)).toBe(false);
    expect(await budget.isSpent(refs.repoId)).toBe(false);
    expect(await budget.record(refs.repoId, 1)).toBe(true);
    expect(await budget.isSpent(refs.repoId)).toBe(true);
    const row = await admin.query(`SELECT bytes::text FROM runner_git_upload_pack_bytes WHERE repo_id = $1`, [refs.repoId]);
    expect(row.rows).toEqual([{ bytes: String(RUNNER_UPLOAD_PACK_DAILY_BYTES_PER_REPO) }]);
  });

  it("ignores a count that is not a positive whole number, and adds a response larger than one call in parts", async () => {
    const other = await seedAccountWithRepo(admin, 6_465);
    const budget = createRunnerCloneBudget(proxyPool);
    for (const bad of [0, -1, 1.5, NaN, Infinity]) expect(await budget.record(other.repoId, bad)).toBeNull();
    expect((await admin.query(`SELECT 1 FROM runner_git_upload_pack_bytes WHERE repo_id = $1`, [other.repoId])).rows).toEqual([]);
    expect(await budget.record(other.repoId, 1_099_511_627_776 + 5)).toBe(true);
    expect((await admin.query(`SELECT bytes::text FROM runner_git_upload_pack_bytes WHERE repo_id = $1`, [other.repoId])).rows).toEqual([{ bytes: String(1_099_511_627_776 + 5) }]);
  });

  it("answers null (the caller refuses) on any database error, and reports a coded class only", async () => {
    const reports = captureReports();
    const broken = { query: vi.fn(async () => { throw Object.assign(new Error("connection to secret-host failed"), { code: "ECONNRESET" }); }) } as unknown as Pool;
    const budget = createRunnerCloneBudget(broken);
    expect(await budget.isSpent(refs.repoId)).toBeNull();
    await expect(budget.record(refs.repoId, 5)).resolves.toBeNull();
    expect(reports.classes.map((c) => c.stage)).toEqual(["github.runner_clone_budget", "github.runner_clone_budget"]);
    expect(reports.everything()).not.toContain("secret-host");
    const odd = createRunnerCloneBudget({ query: vi.fn(async () => ({ rows: [{ spent: "yes" }] })) } as unknown as Pool);
    expect(await odd.isSpent(refs.repoId)).toBeNull();
  });

  it("works out the seconds to the next 00:00 UTC", () => {
    const noon = Date.UTC(2026, 9, 8, 12, 0, 0);
    expect(secondsUntilUtcMidnight(noon)).toBe(12 * 3600);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 9, 9) - 1)).toBe(1);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 9, 9))).toBe(86_400);
  });
});
