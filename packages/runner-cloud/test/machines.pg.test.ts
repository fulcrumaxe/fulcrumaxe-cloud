import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { listMachines, moveProjectRoute, readMachineCapacity, toResponse, type RunnerCloudDeps, type RunPullRequestPort } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

/** [pg] D#845 MC-10a: the machine list and the move route on real Postgres. MC-9's tests hold the rules; these hold the list's shape, UUID and body validation (400), and each refusal's code. */
describe("the machine list and the move route [pg]", () => {
  let h: Harness;
  let f: F2Fixture;
  let other: F2Fixture;
  let ghSeq = 7_900_000 + Math.floor(Math.random() * 100_000);

  async function repo(account: F2Fixture = f, name = `m${ghSeq}`): Promise<string> {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', $4, 'runner_local')`, [id, account.accountId, ++ghSeq, name]);
    // The move starts the engine on the new machine, so the repo is operated (watch, operate and its own tick).
    if (account === f) await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [account.accountId, id]);
    return id;
  }
  async function machine(o: { account?: F2Fixture; name?: string; engine?: "microvm" | "os_sandbox"; mem?: number; kvm?: "present" | "absent" } = {}): Promise<string> {
    const a = o.account ?? f;
    const id = await insertRunner(h.admin, a.accountId, a.o1, {});
    await h.admin.query(`UPDATE runners SET protocol_version = 22, model_auth_present = true, last_seen_at = now() WHERE id = $1`, [id]);
    await h.admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, host_mem_avail_mb, host_disk_free_mb, host_setups_running, host_load_at) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3, $4, 50000, 0, now())`, [id, a.accountId, o.engine ?? "microvm", o.mem ?? 9000]);
    if (o.kvm) await h.admin.query(`UPDATE runners SET kvm = $2 WHERE id = $1 AND account_id = $3`, [id, o.kvm, a.accountId]);
    if (o.name) await h.admin.query(`INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)`, [id, a.accountId, o.name]);
    return id;
  }
  const place = (repoId: string, runnerId: string) => h.admin.query(`INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [f.accountId, repoId, runnerId]);
  const list = async (user = f.m1, account = f.accountId) => toResponse(() => listMachines(h.deps(), { accountId: account, userId: user }));
  const jobKeys = generateKeyPairSync("ed25519");
  const github = { defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: "c".repeat(40), aheadBy: 0, defaultBranch: "main" }) } as unknown as RunPullRequestPort;
  const depsFor = (): RunnerCloudDeps =>
    h.deps({ pullRequests: github, engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKeys.privateKey) }) as never });
  const move = async (repoId: string, body: unknown, user = f.o1) => toResponse(() => moveProjectRoute(depsFor(), { accountId: f.accountId, userId: user }, repoId, body));
  const errorOf = (r: { status: number; body: unknown }) => `${r.status} ${(r.body as { error?: { code?: string } }).error?.code ?? ""}`;
  const placementOf = async (repoId: string) => (await h.admin.query<{ runner_id: string }>(`SELECT runner_id FROM project_placements WHERE repo_id = $1`, [repoId])).rows[0]?.runner_id;

  beforeAll(async () => {
    h = await harness();
    f = await seedF2(h.admin);
    other = await seedF2(h.admin);
    // The account has an engine plan and operate on, which every start needs.
    await h.admin.query(`UPDATE accounts SET engine_quantity = 20, stripe_subscription_status = 'active' WHERE id = $1`, [f.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)`, [f.accountId]);
  });
  afterAll(() => h.close());

  it("lists the account's machines for any member, with tier, liveness, Claude and the placed project, and never another account's", async () => {
    const free = await machine({ name: "free-box", engine: "os_sandbox" });
    const busy = await machine({ name: "busy-box" });
    const theirs = await machine({ account: other, name: "theirs" });
    const r = await repo(f, "widgets");
    const second = await repo(f, "gadgets");
    await place(r, busy);
    const res = await list();
    expect(res.status).toBe(200);
    const machines = (res.body as { machines: Array<{ id: string; name: string; tier: string | null; kvm: string | null; live: boolean; claude: boolean; running: { repo_id: string; name: string } | null }> }).machines;
    expect(machines.find((m) => m.id === free)).toEqual({ id: free, name: "free-box", tier: "standard", kvm: null, live: true, claude: true, running: null });
    expect(machines.find((m) => m.id === busy)).toMatchObject({ tier: "microvm", running: { repo_id: r, name: "acme/widgets" } });
    expect(machines.map((m) => m.id)).not.toContain(theirs);
    // The same account's second repo is not what holds a machine.
    expect(JSON.stringify(machines)).not.toContain(second);
    expect((await list(other.o1)).status).toBe(403); // a user outside the account is refused, not shown an empty list
  });

  it("carries each machine's own reported KVM fact: present, absent, or null when it never reported one; another account's fact never shows", async () => {
    const [yes, no, unknown] = [await machine({ name: "kvm-yes", engine: "os_sandbox", kvm: "present" }), await machine({ name: "kvm-no", engine: "os_sandbox", kvm: "absent" }), await machine({ name: "kvm-unknown", engine: "os_sandbox" })];
    const theirs = await machine({ account: other, name: "kvm-theirs", engine: "os_sandbox", kvm: "present" });
    const res = await list();
    const machines = (res.body as { machines: Array<{ id: string; kvm: string | null }> }).machines;
    const kvm = (id: string) => machines.find((m) => m.id === id)?.kvm;
    expect([kvm(yes), kvm(no), kvm(unknown)]).toEqual(["present", "absent", null]);
    expect(machines.map((m) => m.id)).not.toContain(theirs);
    // The account predicate through the client that bypasses row security: a foreign account id reads none of this account's machines.
    expect(await readMachineCapacity(h.admin, randomUUID())).toEqual([]);
    expect((await readMachineCapacity(h.admin, other.accountId)).find((m) => m.runner_id === theirs)?.kvm).toBe("present");
  });

  it("moves a placed project and answers both machines; the placement is on the new one", async () => {
    const [a, b, r] = [await machine(), await machine(), await repo()];
    await place(r, a);
    const res = await move(r, { to_runner_id: b });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repo_id: r, from_runner_id: a, to_runner_id: b, old_copy: "none" });
    expect(await placementOf(r)).toBe(b);
  });

  it("is 400 invalid_message for a repo id or machine id that is not a UUID, a missing or extra key, and a body that is not an object, with nothing written", async () => {
    const [a, b, r] = [await machine(), await machine(), await repo()];
    await place(r, a);
    const bad: Array<[string, unknown]> = [
      ["not-a-uuid", { to_runner_id: b }],
      [r, { to_runner_id: "nope" }],
      [r, { to_runner_id: 7 }],
      [r, {}],
      [r, { to_runner_id: b, extra: 1 }],
      [r, { to_runner_id: b, carry_state: "yes" }],
      [r, null],
      [r, [b]],
      [r, "text"],
    ];
    for (const [id, body] of bad) expect(errorOf(await move(id, body)), JSON.stringify([id, body])).toBe("400 invalid_message");
    expect(await placementOf(r)).toBe(a);
  });

  it("passes MC-9's refusals through with their codes: not placed, occupied, not eligible, unknown machine, another account's repo, state carry", async () => {
    const [a, b, small, r, free] = [await machine(), await machine(), await machine({ mem: 10 }), await repo(), await repo()];
    await place(r, a);
    await place(await repo(), b);
    expect(errorOf(await move(free, { to_runner_id: b }))).toBe("409 project_not_placed");
    expect(errorOf(await move(r, { to_runner_id: b }))).toBe("409 machine_single_project");
    expect(errorOf(await move(r, { to_runner_id: small }))).toBe("409 machine_not_eligible");
    expect(errorOf(await move(r, { to_runner_id: randomUUID() }))).toBe("404 not_found");
    expect(errorOf(await move(await repo(other), { to_runner_id: b }))).toBe("404 not_found");
    expect(errorOf(await move(r, { to_runner_id: b, carry_state: true }))).toBe("409 state_carry_unavailable");
    expect(errorOf(await move(r, { to_runner_id: a }))).toBe("400 invalid_message");
    expect(errorOf(await move(r, { to_runner_id: b }, f.m1))).toBe("403 forbidden"); // owner or admin only
    expect(await placementOf(r)).toBe(a);
  });
});
