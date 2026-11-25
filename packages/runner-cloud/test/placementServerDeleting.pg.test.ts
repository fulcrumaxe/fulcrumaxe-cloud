import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RunnerHttpError, autoPlaceProject, mintServerProvisioningToken, moveProject, placeProject, readMachineCapacity } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

/**
 * [pg] D#845 MC-12: a server of ours whose delete is under way (`managed_servers.status = 'deleting'`) takes no project, so the project that was just removed from it cannot be
 * placed back between the delete run's two steps. Kept in a file of its own: the [pg] files share one database, and a file that leaves engine sessions behind changes the order-sensitive
 * counts of the engine-ingest file when it grows.
 */
describe("a server that is being deleted takes no project [pg]", () => {
  let h: Harness;
  let f: F2Fixture;
  let ghSeq = 8_800_000 + Math.floor(Math.random() * 100_000);
  const owner = <T>(fn: (client: PoolClient) => Promise<T>, a = f): Promise<T> => withTenant(h.appPool, a.accountId, a.o1, fn);

  async function repo(a = f): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', $4, 'runner_local')", [id, a.accountId, ++ghSeq, `r${ghSeq}`]);
    return id;
  }
  /** A live, eligible machine. */
  async function machine(a = f): Promise<string> {
    const id = await insertRunner(h.admin, a.accountId, a.o1, {});
    await h.admin.query("UPDATE runners SET protocol_version = 22, model_auth_present = true, last_seen_at = now() WHERE id = $1", [id]);
    await h.admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm')", [id, a.accountId]);
    await h.admin.query("UPDATE runner_facts SET host_mem_avail_mb = 9000, host_disk_free_mb = 50000, host_setups_running = 0, host_load_at = now() WHERE runner_id = $1", [id]);
    return id;
  }
  /** A server of ours whose runner is `runnerId`, in the given status. */
  async function serverOf(a: F2Fixture, runnerId: string, status: string): Promise<string> {
    const t = await mintServerProvisioningToken(h.deps({ repoVisibility: async () => "private" }), { accountId: a.accountId, userId: a.o1 }, "subscription");
    const cred = (await h.admin.query<{ id: string }>("SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND removed_at IS NULL", [a.accountId])).rows[0]?.id
      ?? (await h.admin.query<{ id: string }>(
        "INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', '\\x01', $2, '\\x01', 1, 'a1b2', $3) RETURNING id",
        [a.accountId, randomBytes(12), a.o1],
      )).rows[0]!.id;
    return (await h.admin.query<{ id: string }>(
      "INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, runner_id, status) VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4, $5, $6) RETURNING id",
      [a.accountId, cred, t.id, a.o1, runnerId, status],
    )).rows[0]!.id;
  }
  const place = (a: F2Fixture, repoId: string, runnerId: string) => owner((c) => placeProject(c, { accountId: a.accountId, userId: a.o1 }, { repoId, runnerId }), a);
  const at = async (runnerId: string) => (await h.admin.query<{ repo_id: string }>("SELECT repo_id FROM project_placements WHERE runner_id = $1", [runnerId])).rows.map((r) => r.repo_id);
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "ok";
    } catch (error) {
      return error instanceof RunnerHttpError ? `${error.status} ${error.code}` : String((error as Error).message);
    }
  };

  beforeAll(async () => {
    h = await harness();
    f = await seedF2(h.admin);
  });
  afterAll(() => h.close());

  it("refuses to place a project onto it, however eligible it is, and takes it again when the status goes back", async () => {
    const m = await machine();
    const r = await repo();
    const id = await serverOf(f, m, "ready");
    expect((await owner((c) => readMachineCapacity(c, f.accountId))).find((x) => x.runner_id === m)).toMatchObject({ eligible: true, reason: null });
    await h.admin.query("UPDATE managed_servers SET status = 'deleting' WHERE id = $1", [id]);
    expect((await owner((c) => readMachineCapacity(c, f.accountId))).find((x) => x.runner_id === m)).toMatchObject({ eligible: false, reason: "server_deleting" });
    expect(await code(place(f, r, m))).toBe("409 machine_not_eligible");
    expect(await at(m)).toEqual([]);
    await h.admin.query("UPDATE managed_servers SET status = 'ready' WHERE id = $1", [id]);
    await place(f, r, m);
    expect(await at(m)).toEqual([r]);
  });

  it("RACE: the same repo cannot be placed or moved back onto the server between the removal's two steps", async () => {
    const m = await machine();
    const r = await repo();
    await place(f, r, m);
    await serverOf(f, m, "deleting");
    await h.admin.query("DELETE FROM project_placements WHERE repo_id = $1", [r]); // the run's first step
    expect(await code(place(f, r, m))).toBe("409 machine_not_eligible"); // the gap before its second step
    const elsewhere = await machine();
    await place(f, r, elsewhere);
    expect(await code(owner((c) => moveProject(c, { accountId: f.accountId, userId: f.o1 }, { repoId: r, toRunnerId: m })))).toBe("409 machine_not_eligible");
    expect(await at(elsewhere)).toEqual([r]);
  });

  it("auto-placement skips it, and another account's server being deleted does not matter to this account's machine", async () => {
    const sole = await seedF2(h.admin);
    const only = await machine(sole);
    const mine = await machine();
    await serverOf(sole, only, "deleting");
    const roomRepo = await repo(sole);
    const auto = () => owner((c) => autoPlaceProject(c, { accountId: sole.accountId, userId: sole.o1 }, { repoId: roomRepo }), sole);
    expect(await code(auto())).toBe("409 no_eligible_machine");
    expect(await at(only)).toEqual([]);
    await place(f, await repo(), mine);
    expect(await at(mine)).toHaveLength(1);
  });
});
