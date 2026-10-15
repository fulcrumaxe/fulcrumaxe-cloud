import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOUD_VERIFIED_COPY_SHA256, effectiveExecutionMode, effectiveModeSql, sideOfMode } from "../src/effectiveMode.js";
import { EXECUTION_TARGETS, type ExecutionTargetRegistry } from "../src/executionTarget.js";
import { RunPrecheckRefusedError, readExecutionMode, readRunExecutionMode, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import type { RepoVisibility } from "../src/targets/runnerTarget.js";

/**
 * D#599 PL-2: where an item's run goes (the item's placement, else the repo's mode), and the guards every run creation re-checks for the mode it
 * got. Placement is a routing input and never a permission: a refusal leaves no run row, no event and no idempotency claim.
 */
describe("effective placement [pg]", () => {
  const db = pgHarness();
  const MODES = ["sandbox", "runner_local", "runner_verified"] as const;
  const PLACEMENTS = [null, "cloud", "runner"] as const;
  /** The nine expected run modes: NULL follows the repo; `cloud` is always the sandbox; `runner` keeps a runner repo's flavour and is runner_local on a cloud repo. */
  const EXPECTED: Record<string, string> = {
    "null/sandbox": "sandbox", "null/runner_local": "runner_local", "null/runner_verified": "runner_verified",
    "cloud/sandbox": "sandbox", "cloud/runner_local": "sandbox", "cloud/runner_verified": "sandbox",
    "runner/sandbox": "runner_local", "runner/runner_local": "runner_local", "runner/runner_verified": "runner_verified",
  };

  function registry(visibility: RepoVisibility | "throw" = "private") {
    const issuer = createFakeJobIssuer();
    const deps = { limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer, visibility: createFakeVisibility(visibility) };
    const sandbox = new SandboxTarget(createSandboxTargetHarness(db.runWriterPool).deps);
    const reg: ExecutionTargetRegistry = {
      sandbox,
      runner_local: EXECUTION_TARGETS.runner_local(deps),
      runner_verified: EXECUTION_TARGETS.runner_verified({ runner: deps, sandbox }),
    };
    return { issuer, reg };
  }

  async function seed(mode: string, placement: string | null, verifiedCopySha256?: string | null) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: mode, ...(verifiedCopySha256 === undefined ? {} : { verifiedCopySha256 }) });
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    if (placement !== null) await db.admin.query("UPDATE work_items SET placement = $2 WHERE id = $1", [workItemId, placement]);
    return { accountId, repoId, workItemId };
  }

  const input = (w: { accountId: string; repoId: string; workItemId: string }, role: StartAgentRunInput["role"] = "executor"): StartAgentRunInput => ({
    accountId: w.accountId,
    repoId: w.repoId,
    workItemId: w.workItemId,
    role,
    product: "team",
    roleCard: "card",
    prompt: "prompt",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 1, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    ...(role === "executor" ? { pr: 12 } : { headSha: "a".repeat(40) }),
  });

  const runCount = async (accountId: string): Promise<number> => (await db.admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n;
  const claimCount = async (accountId: string): Promise<number> => (await db.admin.query("SELECT count(*)::int AS n FROM agent_run_idempotency_keys WHERE account_id = $1", [accountId])).rows[0].n;

  it("the resolver: 3 item values x 3 repo modes give the 9 run modes, in TypeScript and in SQL, and NULL always equals the repo", async () => {
    for (const placement of PLACEMENTS) {
      for (const mode of MODES) {
        const want = EXPECTED[`${placement}/${mode}`]!;
        expect(effectiveExecutionMode(placement, mode), `${placement}/${mode}`).toBe(want);
        const w = await seed(mode, placement);
        expect(await readExecutionMode(db.runWriterPool, w.accountId, w.repoId, w.workItemId), `sql ${placement}/${mode}`).toBe(want);
        // The same row read through the bare SQL expression (what the review context, the seat and the build facts embed).
        const row = (await db.admin.query(`SELECT ${effectiveModeSql("w", "r")} AS m FROM work_items w JOIN repos r ON r.id = w.repo_id WHERE w.id = $1`, [w.workItemId])).rows[0];
        expect(row.m).toBe(want);
        if (placement === null) expect(want).toBe(mode);
      }
    }
    expect(() => effectiveExecutionMode("elsewhere", "sandbox")).toThrow();
    expect(effectiveExecutionMode(undefined, undefined)).toBe("sandbox");
    expect(sideOfMode("sandbox")).toBe("cloud");
    expect(sideOfMode("runner_verified")).toBe("runner");
  });

  it("the repo's mode applies when no item is named, and an item of ANOTHER repo cannot route this repo's run", async () => {
    const a = await seed("sandbox", null);
    const other = await seed("sandbox", "runner");
    expect(await readExecutionMode(db.runWriterPool, a.accountId, a.repoId)).toBe("sandbox");
    expect(await readExecutionMode(db.runWriterPool, a.accountId, a.repoId, other.workItemId)).toBe("sandbox");
  });

  it("an item set to runner on a repo whose visibility reads public or unknown is refused, and no run row, event or idempotency claim is written", async () => {
    for (const [seen, reason] of [["public", "public_repo"], ["unknown", "repo_visibility_unknown"], ["throw", "repo_visibility_unknown"]] as const) {
      const { reg, issuer } = registry(seen);
      const w = await seed("sandbox", "runner");
      const err = await startAgentRun(db.runWriterPool, reg, { ...input(w), idempotency: { key: `k-${randomUUID()}`, requestHash: "h" } }).catch((e: unknown) => e);
      expect(err, seen).toBeInstanceOf(RunPrecheckRefusedError);
      expect((err as RunPrecheckRefusedError).reason).toBe(reason);
      expect((err as RunPrecheckRefusedError).code).toBe("run_precheck_refused");
      expect(await runCount(w.accountId)).toBe(0);
      expect(await claimCount(w.accountId)).toBe(0);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM run_events WHERE account_id = $1", [w.accountId])).rows[0].n).toBe(0);
      expect(issuer.calls).toEqual([]);
    }
  });

  it("placement is not a permission: the runner target's own refusals (role, backend) apply to a run an item was sent to", async () => {
    const { reg } = registry("private");
    const w = await seed("sandbox", "runner");
    await expect(startAgentRun(db.runWriterPool, reg, { ...input(w), backend: "not-claude-code" })).rejects.toMatchObject({ reason: "backend_not_selectable" });
    await expect(startAgentRun(db.runWriterPool, reg, { ...input(w, "release-manager") })).rejects.toMatchObject({ reason: "role_not_runner_eligible" });
    expect(await runCount(w.accountId)).toBe(0);
  });

  it("an item set to runner on a cloud repo runs as runner_local on a private repo; set to cloud on a runner repo, it runs in our sandbox", async () => {
    const { reg, issuer } = registry("private");
    const toRunner = await seed("sandbox", "runner");
    const started = await startAgentRun(db.runWriterPool, reg, input(toRunner));
    expect(started).toMatchObject({ status: "pending" });
    expect((await db.admin.query("SELECT execution_mode, runtime FROM agent_runs WHERE id = $1", [started.id])).rows[0]).toEqual({ execution_mode: "runner_local", runtime: "runner" });
    expect(issuer.calls).toHaveLength(1);
    expect(await readRunExecutionMode(db.runWriterPool, toRunner.accountId, started.id)).toBe("runner_local");

    const toCloud = await seed("runner_local", "cloud");
    const sandboxed = await startAgentRun(db.runWriterPool, reg, input(toCloud));
    expect(sandboxed).toMatchObject({ status: "running" });
    expect((await db.admin.query("SELECT execution_mode, runtime FROM agent_runs WHERE id = $1", [sandboxed.id])).rows[0]).toEqual({ execution_mode: "sandbox", runtime: "production" });
    expect(issuer.calls).toHaveLength(1);
  });

  it("the run's recorded mode, not the repo's now, is what a caller that stops it reads (it is null for a run that is not visible)", async () => {
    const { reg } = registry("private");
    const w = await seed("sandbox", "runner");
    const started = await startAgentRun(db.runWriterPool, reg, input(w));
    await db.admin.query("UPDATE work_items SET placement = 'cloud' WHERE id = $1", [w.workItemId]);
    expect(await readExecutionMode(db.runWriterPool, w.accountId, w.repoId, w.workItemId)).toBe("sandbox");
    expect(await readRunExecutionMode(db.runWriterPool, w.accountId, started.id)).toBe("runner_local");
    expect(await readRunExecutionMode(db.runWriterPool, w.accountId, randomUUID())).toBeNull();
    expect(await readRunExecutionMode(db.runWriterPool, randomUUID(), started.id)).toBeNull();
  });

  describe("the cloud-verified consent hash", () => {
    it("a verified repo whose stored hash is the current wording starts; one with no stored hash, or another hash, is refused verified_consent_stale and writes nothing", async () => {
      const { reg } = registry("private");
      const current = await seed("runner_verified", null);
      expect(await startAgentRun(db.runWriterPool, reg, input(current))).toMatchObject({ status: "pending" });
      for (const stored of [null, "0".repeat(64)]) {
        const stale = await seed("runner_verified", null, stored);
        await expect(startAgentRun(db.runWriterPool, reg, { ...input(stale), idempotency: { key: `k-${randomUUID()}`, requestHash: "h" } })).rejects.toMatchObject({ code: "run_precheck_refused", reason: "verified_consent_stale" });
        expect(await runCount(stale.accountId)).toBe(0);
        expect(await claimCount(stale.accountId)).toBe(0);
      }
    });

    it("an item sent to the runner of a verified repo meets the same consent check; an item sent to the cloud does not need it", async () => {
      const { reg } = registry("private");
      const stale = await seed("runner_verified", "runner", null);
      await expect(startAgentRun(db.runWriterPool, reg, input(stale))).rejects.toMatchObject({ reason: "verified_consent_stale" });
      const toCloud = await seed("runner_verified", "cloud", null);
      expect(await startAgentRun(db.runWriterPool, reg, input(toCloud))).toMatchObject({ status: "running" });
    });

    it("the database holds the hash only while the repo is runner_verified, in the shape of a SHA-256", async () => {
      const w = await seed("sandbox", null);
      const set = (mode: string, hash: string | null) => db.admin.query("UPDATE repos SET execution_mode = $2, verified_copy_sha256 = $3 WHERE id = $1", [w.repoId, mode, hash]);
      await expect(set("sandbox", CLOUD_VERIFIED_COPY_SHA256)).rejects.toThrow(/repos_verified_copy_sha256_check/);
      await expect(set("runner_local", CLOUD_VERIFIED_COPY_SHA256)).rejects.toThrow(/repos_verified_copy_sha256_check/);
      await expect(set("runner_verified", "ABC")).rejects.toThrow(/repos_verified_copy_sha256_check/);
      await expect(set("runner_verified", CLOUD_VERIFIED_COPY_SHA256.toUpperCase())).rejects.toThrow(/repos_verified_copy_sha256_check/);
      await set("runner_verified", CLOUD_VERIFIED_COPY_SHA256);
      await set("sandbox", null);
    });
  });
});
