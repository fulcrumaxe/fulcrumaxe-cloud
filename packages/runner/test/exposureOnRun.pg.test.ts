import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { resolveExposure } from "../../features/src/resolve.js";
import { FEATURE_CATALOGUE } from "../../features/src/featureExposure.js";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";

// A fixture catalogue in place of the shipped (empty) one: one entry per
// exposure class. Zero model tokens; only the catalogue constant is replaced.
vi.mock("../../features/src/featureExposure.js", async (importActual) => {
  const actual = await importActual<typeof import("../../features/src/featureExposure.js")>();
  return {
    ...actual,
    FEATURE_CATALOGUE: [
      actual.defineFeature({ key: "always_on", class: "silent", addedIn: 1, description: "fixture" }),
      actual.defineFeature({ key: "opt_in", class: "gated", addedIn: 2, securityFloorVersion: 3, description: "fixture" }),
      actual.defineFeature({ key: "paid_only", class: "tier_gated", addedIn: 1, description: "fixture" }),
    ],
  };
});

/**
 * D#2 H-EXPO (amendment 18488789, H04/H09): every new agent_runs row is
 * created with `resolved_exposure` and `exposure_digest` set, resolved
 * server-side for that run's own account.
 */
describe("agent_runs exposure freeze [pg] (H-EXPO)", () => {
  const db = pgHarness();

  async function tenant(plan: "starter" | "team" | "scale", flips: Record<string, "on" | "off"> = {}) {
    const accountId = randomUUID();
    const userId = randomUUID();
    await seedAccount(db.admin, accountId, { plan });
    await seedMember(db.admin, accountId, userId, { role: "owner" });
    for (const [key, state] of Object.entries(flips)) {
      await db.admin.query(
        `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
         VALUES ($1, $2, $3, 'customer', $4)`,
        [accountId, key, state, userId],
      );
    }
    return { accountId, userId };
  }

  async function newRun(accountId: string, pool: Pool = db.runWriterPool) {
    const id = randomUUID();
    await insertAgentRun(pool, { id, accountId, role: "code-reviewer", runtime: "production" });
    const { rows } = await db.admin.query(`SELECT resolved_exposure, exposure_digest FROM agent_runs WHERE id = $1`, [id]);
    return { id, row: rows[0] as { resolved_exposure: { accountId: string; features: Record<string, unknown> }; exposure_digest: string } | undefined };
  }

  it("stores the account's own resolved exposure and a digest of it on the new row", async () => {
    const a = await tenant("starter", { opt_in: "on" });
    const { row } = await newRun(a.accountId);
    expect(row).toBeDefined();
    expect(row!.resolved_exposure).toEqual({
      accountId: a.accountId,
      features: {
        always_on: { class: "silent", state: "on", version: 1, source: "default" },
        opt_in: { class: "gated", state: "on", version: 3, source: "account" },
        paid_only: { class: "tier_gated", state: "off", version: 1, source: "default" },
      },
    });
    expect(row!.exposure_digest).toMatch(/^[0-9a-f]{64}$/);
    // The digest is over the resolver's own canonical JSON (jsonb storage
    // reorders keys, so it is not recomputed from the stored column).
    const again = await resolveExposure(a.accountId, FEATURE_CATALOGUE, db.runWriterPool);
    expect(row!.exposure_digest).toBe(again.digest);
  });

  it("one tenant's flips never reach another tenant's run, whatever their plans", async () => {
    const a = await tenant("scale", { opt_in: "on" });
    const b = await tenant("starter");
    const runB = await newRun(b.accountId);
    expect(runB.row!.resolved_exposure.accountId).toBe(b.accountId);
    expect((runB.row!.resolved_exposure.features as Record<string, unknown>).opt_in).toMatchObject({ state: "off", source: "default" });
    const runA = await newRun(a.accountId);
    expect((runA.row!.resolved_exposure.features as Record<string, unknown>).opt_in).toMatchObject({ state: "on", source: "account" });
    expect(runA.row!.exposure_digest).not.toBe(runB.row!.exposure_digest);
  });

  it("is frozen: a flip after the run was created does not change that run's row", async () => {
    const a = await tenant("team");
    const { id, row } = await newRun(a.accountId);
    await db.admin.query(
      `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
       VALUES ($1, 'opt_in', 'on', 'customer', $2)`,
      [a.accountId, a.userId],
    );
    const after = await db.admin.query(`SELECT resolved_exposure, exposure_digest FROM agent_runs WHERE id = $1`, [id]);
    expect(after.rows[0]).toEqual(row);
  });

  it("fails closed: when resolution throws, no run row and no run event exist", async () => {
    const a = await tenant("team");
    const failing = {
      connect: async () => {
        const client = await db.runWriterPool.connect();
        const original = client.query;
        const query = client.query.bind(client) as (...args: unknown[]) => unknown;
        // The pool reuses this client after release: put its query back first.
        const release = client.release.bind(client);
        client.release = ((err?: Error | boolean) => {
          client.query = original;
          client.release = release;
          release(err);
        }) as typeof client.release;
        (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes("account_features")) {
            return Promise.reject(new Error("exposure store down"));
          }
          return query(...args);
        };
        return client;
      },
    } as unknown as Pool;
    const id = randomUUID();
    await expect(
      insertAgentRun(failing, { id, accountId: a.accountId, role: "code-reviewer", runtime: "production" }),
    ).rejects.toThrow("exposure store down");
    expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE id = $1`, [id])).rows).toEqual([]);
    expect((await db.admin.query(`SELECT 1 FROM run_events WHERE run_id = $1`, [id])).rows).toEqual([]);
  });

  // H-EXPO fix round 1 (amendment 18488789: "resolved ONCE at the start of the
  // work item and FROZEN"). Only the work item's first run resolves; every later
  // run of that work item (a resume included) reuses the frozen value.
  async function workItem(accountId: string) {
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);
    return workItemId;
  }

  async function exposureOf(id: string) {
    const { rows } = await db.admin.query(`SELECT resolved_exposure, exposure_digest FROM agent_runs WHERE id = $1`, [id]);
    return rows[0] as { resolved_exposure: unknown; exposure_digest: string };
  }

  async function flipOptIn(a: { accountId: string; userId: string }, state: "on" | "off") {
    await db.admin.query(
      `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
       VALUES ($1, 'opt_in', $2, 'customer', $3)
       ON CONFLICT (account_id, feature_key) DO UPDATE SET state = EXCLUDED.state`,
      [a.accountId, state, a.userId],
    );
  }

  it("a resumed run of the same work item carries the FIRST run's exposure, not a re-resolved one", async () => {
    const a = await tenant("team");
    const workItemId = await workItem(a.accountId);
    const firstId = randomUUID();
    await insertAgentRun(db.runWriterPool, { id: firstId, accountId: a.accountId, workItemId, role: "code-reviewer", runtime: "production" });
    const first = await exposureOf(firstId);
    await flipOptIn(a, "on");
    const resumedId = randomUUID();
    await insertAgentRun(db.runWriterPool, {
      id: resumedId, accountId: a.accountId, workItemId, parentRunId: firstId, role: "code-reviewer", runtime: "production",
    });
    expect(await exposureOf(resumedId)).toEqual(first);
    // A later run with only the work item id (no parent link) reuses it as well.
    const laterId = randomUUID();
    await insertAgentRun(db.runWriterPool, { id: laterId, accountId: a.accountId, workItemId, role: "code-reviewer", runtime: "production" });
    expect(await exposureOf(laterId)).toEqual(first);
    // A different work item started after the flip resolves the new state.
    const otherWorkItem = await workItem(a.accountId);
    const otherId = randomUUID();
    await insertAgentRun(db.runWriterPool, { id: otherId, accountId: a.accountId, workItemId: otherWorkItem, role: "code-reviewer", runtime: "production" });
    const other = await exposureOf(otherId);
    expect(other.exposure_digest).not.toBe(first.exposure_digest);
    expect((other.resolved_exposure as { features: Record<string, unknown> }).features.opt_in).toMatchObject({ state: "on" });
  });

  it("concurrent first runs of one work item end with one frozen exposure", async () => {
    const a = await tenant("team", { opt_in: "off" });
    const workItemId = await workItem(a.accountId);
    // Every resolution flips opt_in right after it read the rows, so two
    // resolutions that both stuck would disagree.
    const flipping = {
      connect: async () => {
        const client = await db.runWriterPool.connect();
        const original = client.query;
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        // The pool reuses this client after release: put its query back first.
        const release = client.release.bind(client);
        client.release = ((err?: Error | boolean) => {
          client.query = original;
          client.release = release;
          release(err);
        }) as typeof client.release;
        (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          if (typeof args[0] === "string" && args[0].includes("account_features")) {
            await db.admin.query(
              `UPDATE account_features SET state = CASE state WHEN 'on' THEN 'off' ELSE 'on' END
               WHERE account_id = $1 AND feature_key = 'opt_in'`,
              [a.accountId],
            );
          }
          return result;
        };
        return client;
      },
    } as unknown as Pool;
    const ids = Array.from({ length: 6 }, () => randomUUID());
    await Promise.all(
      ids.map((id) => insertAgentRun(flipping, { id, accountId: a.accountId, workItemId, role: "code-reviewer", runtime: "production" })),
    );
    const rows = await Promise.all(ids.map(exposureOf));
    expect(new Set(rows.map((r) => r.exposure_digest)).size).toBe(1);
    expect(new Set(rows.map((r) => JSON.stringify(r.resolved_exposure))).size).toBe(1);
  });

  it("a run without a work item resolves on its own each time", async () => {
    const a = await tenant("team");
    const first = await newRun(a.accountId);
    await flipOptIn(a, "on");
    const second = await newRun(a.accountId);
    expect(second.row!.exposure_digest).not.toBe(first.row!.exposure_digest);
    expect((second.row!.resolved_exposure.features as Record<string, unknown>).opt_in).toMatchObject({ state: "on" });
  });

  it("the definer refuses an exposure whose accountId is not the run's account (23514, no row)", async () => {
    const a = await tenant("team");
    const b = await tenant("team");
    const id = randomUUID();
    const client = await db.runWriterPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
      await expect(
        client.query(
          `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL, $3::jsonb, $4::text)`,
          [id, a.accountId, JSON.stringify({ accountId: b.accountId, features: {} }), "a".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE id = $1`, [id])).rows).toEqual([]);
  });

  it("the definer itself refuses a missing exposure or a malformed digest (no row)", async () => {
    const a = await tenant("team");
    for (const [exposure, digest] of [
      [null, "a".repeat(64)],
      ['{"features":{}}', null],
      ['{"features":{}}', "not-a-digest"],
      ["[]", "a".repeat(64)],
    ] as const) {
      const id = randomUUID();
      const client = await db.runWriterPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
        await expect(
          client.query(
            `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL, $3::jsonb, $4::text)`,
            [id, a.accountId, exposure, digest],
          ),
        ).rejects.toMatchObject({ code: "23502" });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
      expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE id = $1`, [id])).rows).toEqual([]);
    }
  });
});
