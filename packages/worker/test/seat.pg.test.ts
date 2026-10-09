import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ROLE_MANIFEST } from "@fx/roles";
import { SANDBOX_TIMEOUT_MARGIN_MS, SandboxTarget, buildExecutionRun, type ExecutionRun } from "@fx/runner";
import { defaultPerSpawnCapUsd, isClaudeModelId } from "@fx/spend";
import { createSandboxTargetHarness } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { previewSeatContract } from "./support/previewSeatContract.js";
import { PREVIEW_COMPUTE_CAP_USD, PREVIEW_MODEL_CAP_USD, PREVIEW_ROLE } from "../src/preview.js";
import { previewSeatSourceOf } from "../src/compositionRoot.js";
import { createSeatResolver, type SeatRefusal, type SeatRequest, type SeatResult } from "../src/seat.js";

const MIN = 60_000; // [pg] the seat resolver on the run-writer login

describe("seat resolver [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let resolve: (r: SeatRequest) => Promise<SeatResult>;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    resolve = createSeatResolver({ pool: writerPool });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** A team account with a repo, a work item (kind 'feature') and a model budget. */
  async function team(over: { budget?: number; kind?: string | null } = {}): Promise<SeedRefs> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1", [refs.accountId, over.budget ?? 500]);
    if (over.kind !== undefined) await admin.query("UPDATE work_items SET kind = $2 WHERE id = $1", [refs.workItemId, over.kind]);
    return refs;
  }
  const request = (a: SeedRefs, role = "code-reviewer"): SeatRequest => ({ accountId: a.accountId, role, workItemId: a.workItemId });
  const previewRequest = (a: SeedRefs, role = PREVIEW_ROLE): SeatRequest => ({ accountId: a.accountId, role, repoId: a.repoId, purpose: "preview" });
  const setKind = (a: SeedRefs, kind: string) => admin.query("UPDATE installations SET app_kind = $2 WHERE id = $1", [a.installationId, kind]);
  const okSeat = async (req: SeatRequest) => {
    const result = await resolve(req);
    if (!result.ok) throw new Error(`seat refused: ${result.reason}`);
    return result.seat;
  };

  const counts = async (a: SeedRefs) => ({
    runs: Number((await admin.query("SELECT count(*) FROM agent_runs WHERE account_id = $1", [a.accountId])).rows[0].count),
    reservations: Number((await admin.query("SELECT count(*) FROM spend_reservations WHERE account_id = $1", [a.accountId])).rows[0].count),
  });
  async function refusedWith(a: SeedRefs, req: SeatRequest, reason: SeatRefusal, seat = resolve): Promise<void> {
    const harness = createSandboxTargetHarness(writerPool);
    const before = await counts(a);
    expect(await seat(req)).toEqual({ ok: false, reason });
    expect(await counts(a)).toEqual(before);
    expect(harness.fakeSandbox.state.created).toHaveLength(0);
  }

  // CT-1 (H17c): the preview seat contract, run against the real resolver. Its accounts are seeded with no model budget, so the source sets one first.
  previewSeatContract(
    "resolveRunSeat",
    {
      previewSeat: async (accountId, repoId) => {
        await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [accountId]);
        const r = await resolve({ accountId, role: PREVIEW_ROLE, repoId, purpose: "preview" });
        return r.ok ? { ok: true, seat: { ...r.seat, limits: { ...r.seat.limits } } } : r;
      },
    },
    () => admin,
  );
  // H14c-3-3a: the same contract against the composition root's own adapter over the resolver (the piece the root really uses).
  previewSeatContract(
    "the composition root's previewSeatSourceOf over resolveRunSeat",
    {
      previewSeat: async (accountId, repoId) => {
        await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [accountId]);
        return previewSeatSourceOf(resolve).previewSeat(accountId, repoId);
      },
    },
    () => admin,
  );

  it("D#6 R4d-1: the executor's card follows the mode its prompt was built for (the repository's own when none is named); no other role's card changes", async () => {
    const { loadProductCard } = await import("@fx/roles/cards");
    const a = await team();
    const seatCard = async (role: string, expectedExecutionMode?: string) => (await okSeat({ ...request(a, role), ...(expectedExecutionMode !== undefined ? { expectedExecutionMode } : {}) } as SeatRequest)).roleCard;
    // A sandbox repository.
    expect(await seatCard("executor")).toBe(loadProductCard("executor"));
    expect(await seatCard("executor", "runner_local")).toBe(loadProductCard("executor", { runtime: "runner" }));
    // A runner repository.
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [a.repoId]);
    expect(await seatCard("executor")).toBe(loadProductCard("executor", { runtime: "runner" }));
    expect(await seatCard("executor", "sandbox")).toBe(loadProductCard("executor"));
    expect(await seatCard("code-reviewer")).toBe(loadProductCard("code-reviewer"));
    expect(await seatCard("code-reviewer", "runner_local")).toBe(loadProductCard("code-reviewer"));
  });

  it("P6: every manifest role WITH a product card gets an ok seat (one without is refused no_card, below) whose model is priced and which SandboxTarget.admit does not refuse as unknown_model", async () => {
    const { loadProductCard } = await import("@fx/roles/cards");
    for (const { name } of ROLE_MANIFEST.filter((r) => loadProductCard(r.name) !== undefined)) {
      const a = await team();
      const seat = await okSeat(request(a, name));
      expect(isClaudeModelId(seat.model), name).toBe(true);
      expect(seat.roleCard.length).toBeGreaterThan(100);
      const runId = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, $3, 'production', 'pending')", [runId, a.accountId, name]);
      const run: ExecutionRun = { id: runId, accountId: a.accountId, role: name, prompt: "go", ...seat };
      const admitted = await new SandboxTarget(createSandboxTargetHarness(writerPool).deps).admit(run, admin);
      expect(admitted.admitted ? "ok" : admitted.reason, name).not.toBe("unknown_model");
    }
  });

  describe("P7: one refusal per source, and nothing is created beside a refusal", () => {
    it("unknown role", async () => {
      const a = await team();
      await refusedWith(a, { ...request(a), role: "no-such-role" }, "unknown_role");
    });

    it("no card", async () => {
      const a = await team();
      await refusedWith(a, request(a), "no_card", createSeatResolver({ pool: writerPool, loadCard: () => undefined })); // M5: a default card here turns this red
    });

    it("a product run for a role with NO product card is refused no_card with the real card loader: it never falls back to the dev-team card", async () => {
      const a = await team();
      const { loadProductCard, loadRoleCard } = await import("@fx/roles/cards");
      const { ROLE_MANIFEST } = await import("@fx/roles");
      const bare = ROLE_MANIFEST.map((r) => r.name).filter((n) => loadProductCard(n) === undefined);
      expect(bare.length).toBeGreaterThan(0);
      for (const role of bare) {
        expect(loadRoleCard(role), role).toBeDefined(); // a dev-team card exists, and must not be used
        await refusedWith(a, { ...request(a), role }, "no_card", createSeatResolver({ pool: writerPool }));
      }
    });

    it("a work item with no repo", async () => {
      const noRepo = await team();
      await admin.query("UPDATE work_items SET repo_id = NULL WHERE id = $1", [noRepo.workItemId]);
      await refusedWith(noRepo, request(noRepo), "no_repo");
    });

    it("a repo with no installation", async () => {
      const noInstall = await team();
      await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [noInstall.repoId]);
      await refusedWith(noInstall, request(noInstall), "no_installation");
    });

    it("no priced model: no repo override, no routing row, and a tier with no mapping", async () => {
      const noModel = await team({ kind: null });
      await refusedWith(noModel, request(noModel), "no_model", createSeatResolver({ pool: writerPool, tierToModelId: {} }));
    });

    it("model budget 0", async () => {
      const noBudget = await team({ budget: 0 });
      await refusedWith(noBudget, request(noBudget), "model_budget_unset");
    });

    it("model budget 0 for an operator account is not a refusal (our subscription is not paid from the account's budget), but only for one the operator decision names", async () => {
      const operator = await team({ budget: 0 });
      const customer = await team({ budget: 0 });
      await setKind(operator, "team_readonly");
      await setKind(customer, "team_readonly");
      const seats = createSeatResolver({ pool: writerPool, isOperatorAccount: (id) => id === operator.accountId });
      const seat = await seats(previewRequest(operator));
      expect(seat.ok).toBe(true);
      await refusedWith(customer, previewRequest(customer), "model_budget_unset", seats);
      // Without the operator decision wired, nobody is an operator.
      await refusedWith(operator, previewRequest(operator), "model_budget_unset", createSeatResolver({ pool: writerPool }));
      // A decision that merely throws or answers a non-boolean never opens the refusal.
      await refusedWith(customer, previewRequest(customer), "model_budget_unset", createSeatResolver({ pool: writerPool, isOperatorAccount: () => undefined as unknown as boolean }));
    });

    it("limits that exceed the sandbox maximum", async () => {
      const tooLong = await team();
      await refusedWith(tooLong, request(tooLong), "limits_exceed_sandbox", createSeatResolver({ pool: writerPool, maxTimeoutMs: 45 * MIN })); // a Hobby sandbox
    });

    it("account not found (an unknown id, and an id that is not a uuid)", async () => {
      const a = await team();
      const noAccount: SeedRefs = { ...a, accountId: randomUUID() };
      await refusedWith(noAccount, request(noAccount), "account_not_found");
      await refusedWith(a, { ...request(a), accountId: "not-a-uuid" }, "account_not_found");
    });
  });

  it("R-MAX: the default run's sandbox (130 min) is accepted at the plan maximum and refused one millisecond above a smaller one", async () => {
    const a = await team();
    expect((await okSeat(request(a))).timeoutMs).toBe(130 * MIN);
    expect(await createSeatResolver({ pool: writerPool, maxTimeoutMs: 130 * MIN })(request(a))).toMatchObject({ ok: true });
    expect(await createSeatResolver({ pool: writerPool, maxTimeoutMs: 130 * MIN - 1 })(request(a))).toEqual({ ok: false, reason: "limits_exceed_sandbox" });
  });

  it("P8: only a team installation backs a run; read-only, sitekit and none each refuse, with nothing created", async () => {
    for (const [kind, reason] of [["team_readonly", "installation_not_writable"], ["sitekit", "installation_not_writable"]] as const) {
      const a = await team();
      await setKind(a, kind);
      await refusedWith(a, request(a), reason);
    }
    const none = await team();
    await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [none.repoId]);
    await refusedWith(none, request(none), "no_installation");
    expect(await resolve(request(await team()))).toMatchObject({ ok: true });
  });

  it("P9: limits come from the role row, then the account row, then the defaults; the sandbox outlives the longest possible run by the margin", async () => {
    const a = await team();
    await admin.query("INSERT INTO run_limits (account_id, role, max_run_minutes, max_extensions, per_run_usd) VALUES ($1, 'code-reviewer', 30, 1, 12.5)", [a.accountId]);
    await admin.query("INSERT INTO run_limits (account_id, role, max_run_minutes, max_extensions, max_turns) VALUES ($1, '*', 20, 0, 50)", [a.accountId]);
    const role = await okSeat(request(a, "code-reviewer"));
    expect(role.limits).toMatchObject({ maxRunMs: 30 * MIN, maxTurns: 50 }); // the account row fills what the role row leaves null
    expect(role.timeoutMs).toBe((30 + 15) * MIN + SANDBOX_TIMEOUT_MARGIN_MS);
    expect(role.capUsd).toBe(12.5); // M7: the per-spawn cap is run_limits.per_run_usd
    expect(role.maxExtensions).toBe(1); // 8 (M6): the role row's count travels with the seat
    expect(buildExecutionRun(randomUUID(), { ...role, accountId: a.accountId, role: "code-reviewer", workItemId: a.workItemId, prompt: "go" }).maxExtensions).toBe(1); // ... and the run keeps it
    expect(role.spend.perSpawnCapUsd).toBe(12.5);
    const other = await okSeat(request(a, "acceptance-tester"));
    expect(other.limits.maxRunMs).toBe(20 * MIN);
    expect(other.maxExtensions).toBe(0); // the account row: no extensions
    expect(other.timeoutMs).toBe(20 * MIN + SANDBOX_TIMEOUT_MARGIN_MS);

    // F2: the default run is not refused, and its sandbox is 60 + 2 x 30 + 10 minutes. M6: a fixed 2 h timeout turns this red.
    const d = await okSeat(request(await team()));
    expect(d.limits).toEqual({ maxRunMs: 60 * MIN, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * MIN });
    expect(d.timeoutMs).toBe(130 * MIN);
    expect(d.maxExtensions).toBe(2);
    expect(d.capUsd).toBe(defaultPerSpawnCapUsd());
  });

  it("every seat carries the spend facts a reservation needs: a foreground trigger, a compute estimate above zero, the plan and the budget", async () => {
    const seat = await okSeat(request(await team()));
    expect(seat.spend).toMatchObject({ purpose: "run", trigger: "foreground", estimateModelUsd: seat.capUsd, plan: "starter", monthlyModelBudgetUsd: 500, workItemKind: "feature" });
    expect(seat.spend.estimateComputeUsd).toBeGreaterThan(0);
    expect(seat.spend.workItemId).toBeDefined();
  });

  it("P10: the repo's role override beats the routing table; a tier alone maps through the table, and the tier string is never the model", async () => {
    const a = await team();
    expect((await okSeat(request(a, "executor"))).model).toBe("sonnet-5"); // the live table: executor, Feature
    await admin.query("UPDATE role_settings SET model = 'opus-5' WHERE repo_id = $1 AND role = 'executor'", [a.repoId]);
    expect((await okSeat(request(a, "executor"))).model).toBe("opus-5");

    const tierOnly = await team({ kind: null }); // no size: no routing row to read
    const seat = await okSeat(request(tierOnly, "code-reviewer"));
    expect(seat.model).toBe("sonnet-5");
    expect(JSON.stringify(seat)).not.toMatch(/"(haiku|sonnet|opus)"/); // M4: passing the tier through turns this red
    expect((await okSeat(request(tierOnly, "debater"))).model).toBe("haiku-4.5");
  });

  it("P11: a preview seat is for a read-only installation only, capped at $20 model and $1 compute, with no work item", async () => {
    const a = await team();
    await setKind(a, "team_readonly");
    const seat = await okSeat(previewRequest(a));
    expect(seat.spend).toMatchObject({ purpose: "preview", trigger: "foreground", estimateModelUsd: PREVIEW_MODEL_CAP_USD, perSpawnCapUsd: PREVIEW_MODEL_CAP_USD });
    expect(seat.capUsd).toBe(PREVIEW_MODEL_CAP_USD);
    expect(seat.spend.estimateComputeUsd).toBeGreaterThan(0);
    expect(seat.spend.estimateComputeUsd).toBeLessThanOrEqual(PREVIEW_COMPUTE_CAP_USD);
    expect(seat.spend).not.toHaveProperty("workItemId");
    expect(seat.repoId).toBe(a.repoId);
    expect(isClaudeModelId(seat.model)).toBe(true);

    for (const kind of ["team", "sitekit"]) {
      const w = await team();
      await setKind(w, kind);
      await refusedWith(w, previewRequest(w), "no_installation");
    }
    const other = await team();
    const missing = await team();
    await admin.query("DELETE FROM repos WHERE id = $1", [missing.repoId]);
    const stranger: SeatRequest = { ...previewRequest(a), repoId: other.repoId }; // another account's repo
    expect(await resolve(stranger)).toEqual({ ok: false, reason: "no_repo" });
    expect(await resolve({ ...previewRequest(missing) })).toEqual(await resolve(stranger));
  });

  it("P12: another account's work item is the same refusal as a missing one, and nothing is created", async () => {
    const a = await team();
    const b = await team();
    const crossTenant: SeatRequest = { accountId: a.accountId, role: "code-reviewer", workItemId: b.workItemId };
    await refusedWith(a, crossTenant, "no_repo");
    // M8: RLS alone would also refuse that; on a login that bypasses RLS the query's own account filter must hold.
    expect(await createSeatResolver({ pool: adminPool })(crossTenant)).toEqual({ ok: false, reason: "no_repo" });
    const bRepo: SeatRequest = { accountId: a.accountId, role: "code-reviewer", repoId: b.repoId, purpose: "preview" };
    await setKind(b, "team_readonly");
    expect(await createSeatResolver({ pool: adminPool })(bRepo)).toEqual({ ok: false, reason: "no_repo" });
    expect(await resolve({ accountId: a.accountId, role: "code-reviewer", workItemId: randomUUID() })).toEqual({ ok: false, reason: "no_repo" });
  });

  it("P13: the result survives structuredClone unchanged, for a seat and for a refusal", async () => {
    const a = await team();
    for (const result of [await resolve(request(a)), await resolve({ ...request(a), role: "no-such-role" })]) expect(structuredClone(result)).toEqual(result);
  });
});
