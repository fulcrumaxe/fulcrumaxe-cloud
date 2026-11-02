import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFLICT_ATTEST_JOB_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { nextGhInstallationId } from "@fx/db/test/helpers/seed.js";
import { anyRunnerCanTakeConflictRound } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

/**
 * [pg] D#519 MQ4-e2-c3 (C18-3): the one runner state a `runner_local` conflict round is not waited out for. Read as the app login in the account's tenant, so row security is in force.
 * True only for a registered, covering runner at the protocol a conflict round's job needs; an offline, paused, draining or busy one still counts (that round waits).
 */
describe("anyRunnerCanTakeConflictRound [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  async function world() {
    const f: F2Fixture = await seedF2(h.admin);
    const installationId = randomUUID();
    await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')", [installationId, f.accountId, nextGhInstallationId()]);
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team')", [repoId, f.accountId, installationId]);
    return { f, repoId };
  }
  type World = Awaited<ReturnType<typeof world>>;
  async function runner(w: World, o: { protocol?: number | null; repos?: string[]; revoked?: boolean; seen?: Date | null; paused?: boolean } = {}): Promise<string> {
    const id = await insertRunner(h.admin, w.f.accountId, w.f.a1, { credentialMode: "api_key" });
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = $3, allowed_repo_ids = $4::uuid[], revoked_at = $5 WHERE id = $1", [
      id,
      o.seen === undefined ? new Date() : o.seen,
      o.protocol === undefined ? CONFLICT_ATTEST_JOB_MIN_PROTOCOL : o.protocol,
      o.repos ?? [w.repoId],
      o.revoked ? new Date() : null,
    ]);
    if (o.paused) await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at, paused_by, draining, drained_by) VALUES ($1, $2, now(), $3, false, NULL)", [id, w.f.accountId, w.f.a1]);
    return id;
  }
  const can = (w: World) => withTenant(h.appPool, w.f.accountId, (c) => anyRunnerCanTakeConflictRound(c, w.f.accountId, w.repoId));

  it("true for a registered runner at the needed protocol that lists the repository", async () => {
    const w = await world();
    await runner(w);
    expect(await can(w)).toBe(true);
  });

  it("false with no runner at all, or when every one is revoked", async () => {
    const w = await world();
    expect(await can(w)).toBe(false);
    await runner(w, { revoked: true });
    expect(await can(w)).toBe(false);
  });

  it("false when every runner is below the needed protocol (or has never said one), until an updated one is registered", async () => {
    const w = await world();
    await runner(w, { protocol: CONFLICT_ATTEST_JOB_MIN_PROTOCOL - 1 });
    await runner(w, { protocol: null });
    expect(await can(w)).toBe(false);
    await runner(w, { protocol: CONFLICT_ATTEST_JOB_MIN_PROTOCOL + 1 });
    expect(await can(w)).toBe(true);
  });

  it("false when no runner lists the repository (the claim would never offer it the run)", async () => {
    const w = await world();
    await runner(w, { repos: [randomUUID()] });
    await runner(w, { repos: [] });
    expect(await can(w)).toBe(false);
  });

  it("an offline, never-seen or paused runner still counts: that round waits", async () => {
    const w = await world();
    await runner(w, { seen: new Date(Date.now() - 3 * 24 * 3600 * 1000), paused: true });
    expect(await can(w)).toBe(true);
    const w2 = await world();
    await runner(w2, { seen: null });
    expect(await can(w2)).toBe(true);
  });

  it("another account's runner is invisible: it never makes this account's round look reachable", async () => {
    const mine = await world();
    const other = await world();
    await runner(other, { repos: [mine.repoId] });
    expect(await can(mine)).toBe(false);
  });
});
