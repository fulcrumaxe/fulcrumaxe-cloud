import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURVEY_MAX_RUN_MS, SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { loadPlatformCard } from "@fx/roles/cards";
import { createSeatResolver, type SeatRefusal, type SeatRequest, type SeatResult } from "../src/seat.js";

type Mode = "subscription" | "api_key";
interface World extends SeedRefs {
  runnerId: string;
}

/**
 * [pg] D#845 ON-10b1 (Ruling 88, 88.0): the survey seat, on the run-writer login, against real rows. A subscription machine runs at a $0 model budget, an API-key machine meets the normal gate, and a
 * sign-in the cloud cannot tell is an API key. Every other mode, role and machine is refused, and a seat writes nothing.
 */
describe("the survey seat [pg]", () => {
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
    await Promise.all([adminPool.end(), writerPool.end()]);
  });

  /** An account whose repo is on `mode`, with one machine placed on it. `auth: undefined` leaves `model_auth_present` NULL. */
  async function world(o: { budget?: number; mode?: string; credential?: Mode; auth?: boolean | null; place?: boolean } = {}): Promise<World> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = $2 WHERE id = $1", [refs.accountId, o.budget ?? 0]);
    await admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [refs.repoId, o.mode ?? "runner_local"]);
    const runnerId = await insertRunner(admin, refs.accountId, refs.userId, { credentialMode: o.credential ?? "subscription" });
    await admin.query("UPDATE runners SET model_auth_present = $2 WHERE id = $1", [runnerId, o.auth === undefined ? true : o.auth]);
    if (o.place !== false) await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [refs.repoId, refs.accountId, runnerId]);
    return { ...refs, runnerId };
  }
  const survey = (w: { accountId: string; repoId: string }, runnerId: string, role = SURVEY_ROLE): SeatRequest => ({ accountId: w.accountId, role, repoId: w.repoId, runnerId, purpose: "survey" });
  const counts = async (w: SeedRefs) => ({
    runs: Number((await admin.query("SELECT count(*) FROM agent_runs WHERE account_id = $1", [w.accountId])).rows[0].count),
    reservations: Number((await admin.query("SELECT count(*) FROM spend_reservations WHERE account_id = $1", [w.accountId])).rows[0].count),
    setups: Number((await admin.query("SELECT count(*) FROM project_setups WHERE account_id = $1", [w.accountId])).rows[0].count),
  });
  async function ok(req: SeatRequest, seat = resolve) {
    const r = await seat(req);
    if (!r.ok) throw new Error(`seat refused: ${r.reason}`);
    return r.seat;
  }
  async function refused(w: SeedRefs, req: SeatRequest, reason: SeatRefusal, seat = resolve): Promise<void> {
    const before = await counts(w);
    expect(await seat(req)).toEqual({ ok: false, reason });
    expect(await counts(w)).toEqual(before);
  }

  describe("at a model budget of 0 (owner ruling 88.0)", () => {
    it("a subscription machine with a login gets a seat at $0: capUsd 0, no estimate, the borrowed model, the survey's own card and its own clock", async () => {
      const w = await world({ credential: "subscription", auth: true });
      const before = await counts(w);
      const seat = await ok(survey(w, w.runnerId));
      expect(seat.capUsd).toBe(0);
      expect(seat.spend).toMatchObject({ estimateModelUsd: 0, estimateComputeUsd: 0, perSpawnCapUsd: 0, purpose: "run", trigger: "foreground" });
      expect(seat.spend.workItemId).toBeUndefined();
      expect(seat.roleCard).toBe(loadPlatformCard(SURVEY_ROLE));
      expect(seat.repoId).toBe(w.repoId);
      expect(seat.maxExtensions).toBe(0);
      expect(seat.limits.maxRunMs).toBe(SURVEY_MAX_RUN_MS);
      expect(SURVEY_MAX_RUN_MS).toBe(20 * 60_000);
      expect(await counts(w)).toEqual(before);
      // The model and the other limits are the project manager's, as a verifier seat takes them (the verifier needs a budget, so set one now).
      await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [w.accountId]);
      const verify = await ok({ accountId: w.accountId, role: "proposal-verifier", repoId: w.repoId, purpose: "verify", capUsd: 0.25 });
      expect(seat.model).toBe(verify.model);
      expect({ ...seat.limits, maxRunMs: 0 }).toEqual({ ...verify.limits, maxRunMs: 0 });
    });

    it("the model is the repo's project-manager override when there is one", async () => {
      const w = await world({ credential: "subscription", auth: true });
      await admin.query("INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, 'project-manager', 'always', 'opus-5')", [w.accountId, w.repoId]);
      expect((await ok(survey(w, w.runnerId))).model).toBe("opus-5");
    });

    it("an API-key machine with a login is refused model_budget_unset", async () => {
      const w = await world({ credential: "api_key", auth: true });
      await refused(w, survey(w, w.runnerId), "model_budget_unset");
    });

    it.each([
      ["subscription", false],
      ["subscription", null],
      ["api_key", false],
      ["api_key", null],
    ] as const)("%s with auth %s (no login the cloud can see) is refused survey_sign_in_unknown", async (credential, auth) => {
      const w = await world({ credential, auth });
      await refused(w, survey(w, w.runnerId), "survey_sign_in_unknown");
    });

    it("an operator account at 0 keeps its exemption: an API-key or unknown machine is seated, at the normal cap", async () => {
      const operator = createSeatResolver({ pool: writerPool, isOperatorAccount: () => true });
      for (const [credential, auth] of [["api_key", true], ["api_key", null], ["subscription", false]] as const) {
        const w = await world({ credential, auth });
        const seat = await ok(survey(w, w.runnerId), operator);
        expect(seat.capUsd, `${credential} ${String(auth)}`).toBeGreaterThan(0);
      }
      const sub = await world({ credential: "subscription", auth: true });
      expect((await ok(survey(sub, sub.runnerId), operator)).capUsd).toBe(0);
    });

    it("a budget of 0 for any other purpose is still model_budget_unset", async () => {
      const w = await world({ credential: "subscription", auth: true });
      await admin.query("UPDATE installations SET app_kind = 'team_readonly' WHERE id = $1", [w.installationId]);
      await refused(w, { accountId: w.accountId, role: "project-manager", repoId: w.repoId, purpose: "preview" }, "model_budget_unset");
      await refused(w, { accountId: w.accountId, role: "proposal-verifier", repoId: w.repoId, purpose: "verify", capUsd: 0.25 }, "model_budget_unset");
    });
  });

  describe("with a model budget above 0", () => {
    it("API-key and unknown machines take the normal gate (capUsd is the per-run figure); a subscription machine still uses none of it", async () => {
      const api = await world({ budget: 500, credential: "api_key", auth: true });
      const unknown = await world({ budget: 500, credential: "subscription", auth: null });
      const sub = await world({ budget: 500, credential: "subscription", auth: true });
      const apiSeat = await ok(survey(api, api.runnerId));
      const unknownSeat = await ok(survey(unknown, unknown.runnerId));
      expect(apiSeat.capUsd).toBeGreaterThan(0);
      expect(unknownSeat.capUsd).toBe(apiSeat.capUsd);
      expect(apiSeat.spend).toMatchObject({ perSpawnCapUsd: apiSeat.capUsd, estimateModelUsd: apiSeat.capUsd, monthlyModelBudgetUsd: 500, estimateComputeUsd: 0 });
      expect(apiSeat.limits.maxRunMs).toBe(SURVEY_MAX_RUN_MS);
      expect((await ok(survey(sub, sub.runnerId))).capUsd).toBe(0);
    });
  });

  describe("only on the person's own machine, only the placed one", () => {
    it.each(["sandbox", "runner_verified"])("a %s repo is refused survey_needs_runner, whatever the machine or budget", async (mode) => {
      const w = await world({ mode, budget: 500, credential: "subscription", auth: true });
      await refused(w, survey(w, w.runnerId), "survey_needs_runner");
      const unknown = await world({ mode, credential: "api_key", auth: null });
      await refused(unknown, survey(unknown, unknown.runnerId), "survey_needs_runner");
    });

    it("a machine that is not the repo's placement is survey_not_placed, even one of the same account that holds a placement of its own", async () => {
      const a = await world({ budget: 500, credential: "api_key", auth: true });
      const other = await world({ credential: "subscription", auth: true, place: false });
      await refused(a, survey(a, randomUUID()), "survey_not_placed");
      await refused(a, survey(a, "not-a-uuid"), "survey_not_placed");
      // A SECOND repo of the same account, with its own placed machine: that machine is not repo A's.
      const second = randomUUID();
      await admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode, installation_id) VALUES ($1, $2, $3, 'team', 'acme', 'second', 'runner_local', $4)", [second, a.accountId, Math.floor(Math.random() * 1e12), a.installationId]);
      const runnerB = await insertRunner(admin, a.accountId, a.userId, { credentialMode: "subscription" });
      await admin.query("UPDATE runners SET model_auth_present = true WHERE id = $1", [runnerB]);
      await admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')", [second, a.accountId, runnerB]);
      await refused(a, survey(a, runnerB), "survey_not_placed");
      expect((await ok({ accountId: a.accountId, role: SURVEY_ROLE, repoId: second, runnerId: runnerB, purpose: "survey" })).capUsd).toBe(0);
      // Another account's machine, named for this account's repo, is nobody's.
      await refused(a, survey(a, other.runnerId), "survey_not_placed");
    });

    it("a revoked machine is survey_not_placed", async () => {
      const w = await world({ budget: 500, credential: "api_key", auth: true });
      await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [w.runnerId]);
      await refused(w, survey(w, w.runnerId), "survey_not_placed");
    });

    it("read through a client that bypasses row security, another account's machine and repo are still no seat (the predicates name the account)", async () => {
      const a = await world({ budget: 500, credential: "api_key", auth: true });
      const b = await world({ budget: 500, credential: "subscription", auth: true });
      const bypass = createSeatResolver({ pool: adminPool });
      expect((await bypass(survey(a, b.runnerId)))).toEqual({ ok: false, reason: "survey_not_placed" });
      expect((await bypass({ accountId: a.accountId, role: SURVEY_ROLE, repoId: b.repoId, runnerId: b.runnerId, purpose: "survey" }))).toEqual({ ok: false, reason: "no_repo" });
      expect((await bypass({ accountId: b.accountId, role: SURVEY_ROLE, repoId: a.repoId, runnerId: a.runnerId, purpose: "survey" }))).toEqual({ ok: false, reason: "no_repo" });
      expect((await bypass(survey(a, a.runnerId))).ok).toBe(true);
    });

    it("the survey reads through either team App and nothing else", async () => {
      const w = await world({ budget: 500, credential: "api_key", auth: true });
      for (const kind of ["team", "team_readonly"]) {
        await admin.query("UPDATE installations SET app_kind = $2 WHERE id = $1", [w.installationId, kind]);
        expect((await ok(survey(w, w.runnerId))).repoId).toBe(w.repoId);
      }
      await admin.query("UPDATE installations SET app_kind = 'sitekit' WHERE id = $1", [w.installationId]);
      await refused(w, survey(w, w.runnerId), "no_installation");
    });
  });

  describe("the role", () => {
    it("any role but the surveyor is unknown_role for a survey seat", async () => {
      const w = await world({ budget: 500, credential: "api_key", auth: true });
      for (const role of ["project-manager", "proposal-verifier", "discovery-analyst", "executor", "no-such-role", ""]) await refused(w, survey(w, w.runnerId, role), "unknown_role");
    });
  });

  it("the fact comes from the stored row: none of the seat's code reads a file, the home directory or any Claude state", () => {
    for (const file of ["../src/seat.ts", "../src/surveyStart.ts", "../../db/src/runnerSignIn.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/from "node:(fs|os|child_process)"|from "(fs|os)"|homedir|\.claude|process\.env/);
    }
  });
});
