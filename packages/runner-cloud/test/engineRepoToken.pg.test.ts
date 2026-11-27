import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_TOKEN_PATH, REPO_TOKEN_STOP_PATH, RepoTokenReply, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { readEngineRepos } from "@fx/core/src/engine/panels.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { engineRepoTokenRun, engineRepoTokenStopRun, retryEngineStop, type RunnerCloudDeps } from "../src/index.js";
import { REPO_TOKEN_MINTS_PER_HOUR } from "../src/engineRepoToken.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const TOKEN = "ghs_sentinel_engine_session_token_0123456789";
const HEAD = "a".repeat(40);

/**
 * [pg] D#845 ON-18 (Rulings 70, 126): the repo-token route over the real signed HTTP path, the real tables and row security forced, as the runner's own session. The GitHub App is a fake that records what it was asked
 * for. Every condition of "a running session" is turned off in turn, and the same account's second repository and another account's runner are asked for the first one's token.
 */
describe("engine repo token [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  let nextGh = 700_000;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const minted: Array<{ id: string; owner: string; name: string }> = [];
  const revoked: string[] = [];
  const port = (over: { fail?: unknown } = {}) => ({
    async mint(repo: { id: string; owner: string; name: string }) {
      if (over.fail !== undefined) throw over.fail;
      minted.push(repo);
      return { token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) };
    },
    async revoke(token: string) {
      revoked.push(token);
    },
  });
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ engineRepoToken: port(), engineCommandSigner: async () => signer as never, ...over });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number; startId: string }
  /** A fresh account: one named repo placed on one machine, an engine plan, watch and operate on (epoch 1), the repo ticked, a delivered start and a live lease for that machine. Each can be turned off. */
  async function rig(o: { operate?: boolean; tick?: boolean; plan?: "active" | "ended"; start?: string | null; lease?: number | null; leaseEpoch?: number; place?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    const ghRepoId = (nextGh += 1); // every rig has its own GitHub id, so a name that fits two accounts would hide a missing account predicate
    await h.admin.query("UPDATE repos SET gh_repo_id = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId, ghRepoId]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    if (o.place !== false) await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = 1, stripe_subscription_status = 'active', subscription_ended_at = $2 WHERE id = $1", [who.accountId, o.plan === "ended" ? new Date(Date.now() - 86_400_000) : null]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    if (o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const r = { who, key, runnerId, ghRepoId, startId: "" };
    if (o.start !== null) r.startId = await start(r, o.start ?? "delivered");
    if (o.lease !== null) await h.admin.query("INSERT INTO engine_session_leases (account_id, repo_id, runner_id, operate_epoch, expires_at) VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')", [who.accountId, who.repoId, runnerId, o.leaseEpoch ?? 1, o.lease ?? 600]);
    return r;
  }
  async function start(r: Rig, state: string, ago = 60_000): Promise<string> {
    const id = randomUUID();
    const issued = new Date(Date.now() - ago);
    const expires = new Date(issued.getTime() + 25 * 60_000);
    const job = signMachineJob({ v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "engine_session_start", args: { at_sha: HEAD, resume: false, operate_epoch: 1 } } as MachineJob, "job-key-1", keys.privateKey);
    await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, 'engine_session_start', $5::jsonb, $6, $7, $8, $9)", [id, r.who.accountId, r.runnerId, r.who.repoId, JSON.stringify(job), state, issued, expires, state === "issued" ? null : issued]);
    return id;
  }
  /** A stop or delete of the repository, issued `ago` ms ago (newer than the start unless `ago` is larger than the start's), in any state. */
  async function later(r: Rig, kind: "engine_session_stop" | "engine_session_delete", state: string, ago = 5_000): Promise<string> {
    const id = randomUUID();
    const issued = new Date(Date.now() - ago);
    const expires = new Date(issued.getTime() + 25 * 60_000);
    const args = kind === "engine_session_stop" ? { reason: "person", operate_epoch: 1 } : { operate_epoch: 1 };
    const job = signMachineJob({ v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind, args } as MachineJob, "job-key-1", keys.privateKey);
    await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)", [id, r.who.accountId, r.runnerId, r.who.repoId, kind, JSON.stringify(job), state, issued, expires, state === "issued" ? null : issued]);
    return id;
  }
  const ask = (r: Rig, o: { key?: TestKey; body?: unknown; deps?: RunnerCloudDeps } = {}) => respond(() => engineRepoTokenRun(o.deps ?? depsFor(), signed(o.key ?? r.key, REPO_TOKEN_PATH, o.body ?? { repo_gh_id: r.ghRepoId, session_id: r.startId })));
  const refusedAs = (status: number, code: string) => ({ status, body: { error: { code } } });
  const NOT_RUNNING = refusedAs(409, "session_not_running");

  it("hands over one token for the repository of our own rows, with no-store, and keeps no copy of it", async () => {
    const r = await rig();
    minted.length = 0;
    const got = await ask(r);
    expect(got.status).toBe(200);
    expect(got.headers?.["cache-control"]).toBe("no-store");
    expect(RepoTokenReply.parse(got.body).token).toBe(TOKEN);
    expect(minted).toEqual([{ id: r.who.repoId, owner: "acme", name: "widgets" }]);
    for (const table of ["machine_jobs", "engine_session_leases", "audit_log", "runners"]) expect(JSON.stringify((await h.admin.query(`SELECT t.* FROM ${table} t`)).rows)).not.toContain(TOKEN);
    // every ask is a fresh mint: a second one is allowed and is a second token
    expect((await ask(r)).status).toBe(200);
    expect(minted).toHaveLength(2);
  });

  it("a start that is done is a running session too", async () => {
    const r = await rig({ start: "done" });
    expect((await ask(r)).status).toBe(200);
  });

  describe("a session that is not running", () => {
    it("no start at all, a start still only issued, and a failed start answer 409 session_not_running", async () => {
      for (const o of [{ start: null }, { start: "issued" }, { start: "failed" }, { start: "expired" }] as const) {
        const r = await rig(o);
        r.startId = o.start === null ? randomUUID() : r.startId;
        minted.length = 0;
        expect(await ask(r), String(o.start)).toMatchObject(NOT_RUNNING);
        expect(minted).toEqual([]);
      }
    });

    it("a session id that is not the newest start's is refused: a newer start makes the old id invalid, and a random id was never valid", async () => {
      const r = await rig();
      const old = r.startId;
      expect((await ask(r)).status).toBe(200);
      await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [old]);
      const newer = await start(r, "delivered", 1_000);
      expect(await ask(r, { body: { repo_gh_id: r.ghRepoId, session_id: old } })).toMatchObject(NOT_RUNNING);
      expect(await ask(r, { body: { repo_gh_id: r.ghRepoId, session_id: randomUUID() } })).toMatchObject(NOT_RUNNING);
      expect((await ask(r, { body: { repo_gh_id: r.ghRepoId, session_id: newer } })).status).toBe(200);
    });

    it("an expired lease, a missing lease and a lease of an older epoch are refused", async () => {
      expect(await ask(await rig({ lease: -5 }))).toMatchObject(NOT_RUNNING);
      expect(await ask(await rig({ lease: null }))).toMatchObject(NOT_RUNNING);
      const r = await rig();
      // operate turned off and on again is a new epoch: the lease of the old one gives nothing
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
      expect((await h.admin.query<{ operate_epoch: number }>("SELECT operate_epoch FROM engine_bridge_settings WHERE account_id = $1", [r.who.accountId])).rows[0]!.operate_epoch).toBeGreaterThan(1);
      expect(await ask(r)).toMatchObject(NOT_RUNNING);
    });

    it("operate off, a repo that is not ticked, and an ended plan are refused", async () => {
      expect(await ask(await rig({ operate: false }))).toMatchObject(NOT_RUNNING);
      expect(await ask(await rig({ tick: false }))).toMatchObject(NOT_RUNNING);
      expect(await ask(await rig({ plan: "ended" }))).toMatchObject(NOT_RUNNING);
    });

    it("a token is refused the moment a cause ends the session, and not given again by turning the cause back on (that is a new epoch, which needs a new start)", async () => {
      const r = await rig();
      expect((await ask(r)).status).toBe(200);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      expect(await ask(r)).toMatchObject(NOT_RUNNING);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
      expect(await ask(r)).toMatchObject(NOT_RUNNING);
    });
  });

  describe("who may ask", () => {
    it("a repository that is not on this machine, or not the account's, is 404 and nothing is minted", async () => {
      const a = await rig();
      const other = await rig();
      minted.length = 0;
      // another account's machine asks for this account's repository
      expect(await ask(a, { key: other.key })).toMatchObject(refusedAs(404, "not_found"));
      // the same account's second machine, with its own live session on its own repository, asks for the first one's
      const second = newKey();
      const secondRunner = await registerKey(h.admin, a.who.accountId, a.who.userId, second);
      expect(await ask(a, { key: second })).toMatchObject(refusedAs(404, "not_found"));
      expect(secondRunner).not.toBe(a.runnerId);
      // a repository id nobody has
      expect(await ask(a, { body: { repo_gh_id: 9_999_999_999, session_id: a.startId } })).toMatchObject(refusedAs(404, "not_found"));
      expect(minted).toEqual([]);
    });

    it("the same account's SECOND repository on a second machine: each machine gets a token for its own repository only", async () => {
      const a = await rig();
      const secondRepo = (await h.admin.query<{ id: string; gh_repo_id: string }>("INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT account_id, installation_id, $2, product, 'acme', 'gadgets' FROM repos WHERE id = $1 RETURNING id, gh_repo_id", [a.who.repoId, (nextGh += 1)])).rows[0]!;
      const key = newKey();
      const runnerId = await registerKey(h.admin, a.who.accountId, a.who.userId, key);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [secondRepo.id, a.who.accountId, runnerId]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [a.who.accountId, secondRepo.id]);
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [a.who.accountId]);
      const second: Rig = { who: { ...a.who, repoId: secondRepo.id }, key, runnerId, ghRepoId: Number(secondRepo.gh_repo_id), startId: "" };
      second.startId = await start(second, "delivered");
      await h.admin.query("INSERT INTO engine_session_leases (account_id, repo_id, runner_id, operate_epoch, expires_at) VALUES ($1, $2, $3, 1, now() + interval '10 minutes')", [a.who.accountId, secondRepo.id, runnerId]);
      minted.length = 0;
      expect((await ask(second)).status).toBe(200);
      expect(minted).toEqual([{ id: secondRepo.id, owner: "acme", name: "gadgets" }]);
      expect((await ask(a)).status).toBe(200);
      expect(minted[1]).toEqual({ id: a.who.repoId, owner: "acme", name: "widgets" });
      // crossed: each machine asks for the other's repository, with the other's own (valid) session id
      minted.length = 0;
      expect(await ask(a, { body: { repo_gh_id: second.ghRepoId, session_id: second.startId } })).toMatchObject(refusedAs(404, "not_found"));
      expect(await ask(second, { body: { repo_gh_id: a.ghRepoId, session_id: a.startId } })).toMatchObject(refusedAs(404, "not_found"));
      // and this machine's own repository with the other's session id gives nothing
      expect(await ask(a, { body: { repo_gh_id: a.ghRepoId, session_id: second.startId } })).toMatchObject(NOT_RUNNING);
      expect(minted).toEqual([]);
    });

    it("through a pool that bypasses row security, another account's repository, start and lease are still never read: the route names the account on every read", async () => {
      const a = await rig();
      const b = await rig();
      const bypass = depsFor({ appUserPool: h.adminPool });
      minted.length = 0;
      // the same number on both accounts would be found by a read that names no account: give b's repository a's number
      await h.admin.query("UPDATE repos SET gh_repo_id = $2 WHERE id = $1", [b.who.repoId, a.ghRepoId]);
      // a's own session still answers with a's repository, never b's
      expect((await ask(a, { deps: bypass })).status).toBe(200);
      expect(minted).toEqual([{ id: a.who.repoId, owner: "acme", name: "widgets" }]);
      // b's start id and a's key: the start is another account's, so it is not a's newest, and nothing of b is minted
      expect(await ask(a, { deps: bypass, body: { repo_gh_id: a.ghRepoId, session_id: b.startId } })).toMatchObject(NOT_RUNNING);
      // b's key asks for the number both accounts now have: only b's own repository, placement and start are considered
      minted.length = 0;
      expect((await ask(b, { deps: bypass, body: { repo_gh_id: a.ghRepoId, session_id: b.startId } })).status).toBe(200);
      expect(minted).toEqual([{ id: b.who.repoId, owner: "acme", name: "widgets" }]);
    });

    it("another account's repository is 404 for this account's key", async () => {
      const a = await rig();
      const b = await rig();
      expect(await ask(a, { body: { repo_gh_id: b.ghRepoId, session_id: b.startId } })).toMatchObject(refusedAs(404, "not_found"));
    });

    it("a lease held by another machine of the account, and a newer start of the same repository on another machine, are not this machine's session", async () => {
      const a = await rig();
      const second = newKey();
      const secondRunner = await registerKey(h.admin, a.who.accountId, a.who.userId, second);
      await h.admin.query("UPDATE engine_session_leases SET runner_id = $2 WHERE account_id = $1", [a.who.accountId, secondRunner]);
      expect(await ask(a)).toMatchObject(NOT_RUNNING);
      await h.admin.query("UPDATE engine_session_leases SET runner_id = $2 WHERE account_id = $1", [a.who.accountId, a.runnerId]);
      expect((await ask(a)).status).toBe(200);
      // a newer start of the same repository, delivered to the other machine
      await start({ ...a, runnerId: secondRunner }, "delivered", 1_000);
      expect((await ask(a)).status).toBe(200);
    });

    it("a repository moved to another machine: the new machine, placed and leased, is refused the old machine's start id, through row security and through a pool that bypasses it", async () => {
      const a = await rig();
      const second = newKey();
      const secondRunner = await registerKey(h.admin, a.who.accountId, a.who.userId, second);
      // the repository moves from the first machine to the second, which now holds the repository's live lease of the current epoch; the only start on record is the first machine's
      await h.admin.query("UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1", [a.who.repoId, secondRunner]);
      await h.admin.query("UPDATE engine_session_leases SET runner_id = $3 WHERE account_id = $1 AND repo_id = $2", [a.who.accountId, a.who.repoId, secondRunner]);
      minted.length = 0;
      const asSecond = { key: second, body: { repo_gh_id: a.ghRepoId, session_id: a.startId } };
      expect(await ask(a, asSecond)).toMatchObject(NOT_RUNNING);
      // the same read with row security out of the way: only the route's own runner predicate keeps the first machine's start from being the second machine's session
      expect(await ask(a, { ...asSecond, deps: depsFor({ appUserPool: h.adminPool }) })).toMatchObject(NOT_RUNNING);
      expect(minted).toEqual([]);
      // and the second machine's own start is honoured
      const own = await start({ ...a, runnerId: secondRunner }, "delivered", 1_000);
      expect((await ask(a, { key: second, body: { repo_gh_id: a.ghRepoId, session_id: own } })).status).toBe(200);
    });

    it("a stop or a delete of the repository, issued after the start, ends minting at once; a failed or expired one does not, and a later start gives the session back", async () => {
      const a = await rig({ start: "done" }); // one delivered job per machine at a time: the stop below may be the delivered one
      let clock = new Date();
      const ask = (r: Rig, o: { key?: TestKey; body?: unknown; bypass?: boolean } = {}) => {
        clock = new Date(clock.getTime() + 600_000); // ten minutes between asks: the hourly cap is not what this test is about
        return respond(() => engineRepoTokenRun(depsFor({ now: () => clock, ...(o.bypass === true ? { appUserPool: h.adminPool } : {}) }), signed(o.key ?? r.key, REPO_TOKEN_PATH, o.body ?? { repo_gh_id: r.ghRepoId, session_id: r.startId }, { created: Math.floor(clock.getTime() / 1000) })));
      };
      expect((await ask(a)).status).toBe(200);
      for (const kind of ["engine_session_stop", "engine_session_delete"] as const) {
        for (const state of ["issued", "delivered", "done"]) {
          const id = await later(a, kind, state);
          expect(await ask(a), `${kind} ${state}`).toMatchObject(NOT_RUNNING);
          await h.admin.query("DELETE FROM machine_jobs WHERE id = $1", [id]);
          expect((await ask(a)).status, `${kind} ${state} gone`).toBe(200);
        }
        for (const state of ["failed", "expired"]) {
          const id = await later(a, kind, state);
          expect((await ask(a)).status, `${kind} ${state}`).toBe(200);
          await h.admin.query("DELETE FROM machine_jobs WHERE id = $1", [id]);
        }
      }
      // a stop on ANOTHER machine of the account is not this machine's stop
      const second = newKey();
      const secondRunner = await registerKey(h.admin, a.who.accountId, a.who.userId, second);
      await later({ ...a, runnerId: secondRunner }, "engine_session_stop", "done");
      expect((await ask(a)).status).toBe(200);
      expect((await ask(a, { bypass: true })).status).toBe(200); // and with row security out of the way, only the route's own runner predicate says so
      // a stop, then a newer start (a new session): the new start's id works, the old one does not
      await later(a, "engine_session_stop", "done", 30_000);
      expect(await ask(a)).toMatchObject(NOT_RUNNING);
      const fresh = await start(a, "delivered", 1_000);
      expect((await ask(a, { body: { repo_gh_id: a.ghRepoId, session_id: fresh } })).status).toBe(200);
      expect(await ask(a)).toMatchObject(NOT_RUNNING);
    });

    it("a runner is given at most 12 tokens an hour for one repository, then 429 with a wait; refused asks do not count, another machine has its own count, and the hour clears it", async () => {
      const a = await rig();
      let clock = new Date();
      const at = (r: Rig, body?: unknown) => respond(() => engineRepoTokenRun(depsFor({ now: () => clock }), signed(r.key, REPO_TOKEN_PATH, body ?? { repo_gh_id: r.ghRepoId, session_id: r.startId }, { created: Math.floor(clock.getTime() / 1000) })));
      for (let i = 0; i < 5; i++) expect(await at(a, { repo_gh_id: a.ghRepoId, session_id: randomUUID() })).toMatchObject(NOT_RUNNING);
      minted.length = 0;
      for (let i = 0; i < REPO_TOKEN_MINTS_PER_HOUR; i++) expect((await at(a)).status, `ask ${i + 1}`).toBe(200);
      const over = await at(a);
      expect(over).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
      expect(JSON.stringify(over.body)).toMatch(/retry_after/);
      expect(minted).toHaveLength(REPO_TOKEN_MINTS_PER_HOUR);
      // another machine (and so another repository) has its own count
      const other = await rig();
      expect((await at(other)).status).toBe(200);
      expect((await at(a)).status).toBe(429);
      clock = new Date(clock.getTime() + 3600_000 + 1000);
      expect((await at(a)).status).toBe(200);
    });

    it("a newer start of ANOTHER repository on this machine is not this repository's newest start", async () => {
      const a = await rig();
      const other = (await h.admin.query<{ id: string; gh_repo_id: string }>("INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT account_id, installation_id, $2, product, 'acme', 'gadgets' FROM repos WHERE id = $1 RETURNING id, gh_repo_id", [a.who.repoId, (nextGh += 1)])).rows[0]!;
      await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [a.startId]);
      await start({ ...a, who: { ...a.who, repoId: other.id }, ghRepoId: Number(other.gh_repo_id) }, "delivered", 1_000);
      expect((await ask(a)).status).toBe(200);
    });

    it("a removed machine's key is refused before anything is read", async () => {
      const r = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect([401, 403]).toContain((await ask(r)).status);
    });
  });

  describe("the message and the mint", () => {
    it("takes no owner, name or permission list from the message, and an extra key or a bad shape is 400", async () => {
      const r = await rig();
      for (const body of [{ repo_gh_id: r.ghRepoId, session_id: r.startId, repo: "evil/other" }, { repo_gh_id: r.ghRepoId }, { session_id: r.startId }, { repo_gh_id: 0, session_id: r.startId }, { repo_gh_id: r.ghRepoId, session_id: "not-a-uuid" }, {}]) {
        expect((await ask(r, { body })).status, JSON.stringify(body)).toBe(400);
      }
    });

    it("maps a mint that cannot be made to a fixed status, with no GitHub text, and 503 when no port is configured", async () => {
      const r = await rig();
      expect(await ask(r, { deps: depsFor({ engineRepoToken: port({ fail: Object.assign(new Error("x"), { code: "app_not_installed" }) }) }) })).toMatchObject(refusedAs(409, "app_not_installed"));
      expect(await ask(r, { deps: depsFor({ engineRepoToken: port({ fail: Object.assign(new Error("secret text"), { reason: "token_scope_mismatch" }) }) }) })).toMatchObject({ status: 502 });
      const down = await ask(r, { deps: depsFor({ engineRepoToken: port({ fail: new Error("secret text ghs_zzz") }) }) });
      expect(down).toMatchObject({ status: 503 });
      expect(JSON.stringify(down.body)).not.toMatch(/secret|ghs_/);
      expect((await ask(r, { deps: depsFor({ engineRepoToken: null }) })).status).toBe(503);
    });

    it("a repository with no name on record is 409 repo_unnamed and mints nothing", async () => {
      const r = await rig();
      await h.admin.query("UPDATE repos SET gh_owner = NULL, gh_name = NULL WHERE id = $1", [r.who.repoId]);
      minted.length = 0;
      expect(await ask(r)).toMatchObject(refusedAs(409, "repo_unnamed"));
      expect(minted).toEqual([]);
    });

    it("a replayed signed request is refused (a single-use nonce)", async () => {
      const r = await rig();
      const request = signed(r.key, REPO_TOKEN_PATH, { repo_gh_id: r.ghRepoId, session_id: r.startId });
      expect((await respond(() => engineRepoTokenRun(depsFor(), request))).status).toBe(200);
      expect(await respond(() => engineRepoTokenRun(depsFor(), request))).toMatchObject(refusedAs(409, "nonce_reused"));
    });
  });

  /** D#845 ON-18 (Ruling 126.2): the runner's report of the stop it makes when the token cannot be refreshed. */
  describe("the stop report", () => {
    const report = (r: Rig, o: { key?: TestKey; body?: unknown; deps?: RunnerCloudDeps } = {}) =>
      respond(() => engineRepoTokenStopRun(o.deps ?? depsFor(), signed(o.key ?? r.key, REPO_TOKEN_STOP_PATH, o.body ?? { repo_gh_id: r.ghRepoId, session_id: r.startId })));
    const reportJobs = async (r: Rig) =>
      (await h.admin.query<{ id: string; state: string; stop_reason: string; failure_code: string | null; delivered_at: Date | null; job: { job: MachineJob; key_id: string } }>(
        "SELECT id, state, stop_reason, failure_code, delivered_at, job FROM machine_jobs WHERE account_id = $1 AND kind = 'engine_session_stop' ORDER BY issued_at", [r.who.accountId])).rows;
    const audits = async (r: Rig) => (await h.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'engine_session.token_refresh_failed'", [r.who.accountId])).rows[0]!.n;
    const sandboxUp = (r: Rig) =>
      h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, $2, $3, $4, 'running', now() - interval '1 hour', 1000, 1)", [r.runnerId, r.ghRepoId % 150, r.who.accountId, `fx-engine-${r.ghRepoId}`]);

    it("records one failed stop of the reason token_refresh_failed, signed by the cloud for this machine, with one audit row; a second report answers already and writes nothing", async () => {
      const a = await rig();
      expect(await report(a)).toMatchObject({ status: 200, body: { result: "recorded" } });
      const rows = await reportJobs(a);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "failed", stop_reason: "token_refresh_failed", failure_code: null });
      expect(rows[0]!.delivered_at).not.toBeNull();
      const signed = verifyMachineJob(rows[0]!.job as never, { "job-key-1": keys.publicKey }, a.runnerId);
      expect(signed).toMatchObject({ kind: "engine_session_stop", runner_id: a.runnerId, repo_gh_id: a.ghRepoId, args: { reason: "token_refresh_failed", operate_epoch: 1 } });
      expect(await audits(a)).toBe(1);
      expect(await report(a)).toMatchObject({ status: 200, body: { result: "already" } });
      expect(await reportJobs(a)).toHaveLength(1);
      expect(await audits(a)).toBe(1);
      // a new session (a newer start) can be reported again
      await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [a.startId]);
      const fresh = await start(a, "delivered", -1_000); // issued after the report, as a real new start is
      expect(await report(a, { body: { repo_gh_id: a.ghRepoId, session_id: fresh } })).toMatchObject({ status: 200, body: { result: "recorded" } });
      expect(await reportJobs(a)).toHaveLength(2);
    });

    it("the repo list then shows stop_failed with the reason while the sandbox is up, Try again reissues it as a person's stop, and it clears when the sandbox is down", async () => {
      const a = await rig();
      await sandboxUp(a);
      expect((await report(a)).status).toBe(200);
      const member = a.who.userId;
      const failed = async () => (await withTenant(h.appPool, a.who.accountId, member, (c) => readEngineRepos(c, a.who.accountId))).find((i) => i.repo_id === a.who.repoId)?.stop_failed;
      expect(await failed()).toMatchObject({ reason: "token_refresh_failed", code: null });
      const again = await retryEngineStop(depsFor(), { accountId: a.who.accountId, userId: a.who.userId }, a.who.repoId);
      expect(again).toMatchObject({ status: 200, body: { kind: "engine_session_stop", already_issued: false } });
      const rows = await reportJobs(a);
      expect(rows.map((r) => [r.stop_reason, r.state])).toEqual([["token_refresh_failed", "failed"], ["person", "issued"]]);
      expect(await failed()).toBeNull(); // the newest job is the new stop, not a failed one
      await h.admin.query("DELETE FROM machine_jobs WHERE id = $1", [rows[1]!.id]);
      expect(await failed()).toMatchObject({ reason: "token_refresh_failed" });
      await h.admin.query("UPDATE runner_sandboxes SET state = 'stopped' WHERE account_id = $1", [a.who.accountId]);
      expect(await failed()).toBeNull();
    });

    it("is refused for another machine, a session that is not the newest, an unknown id, a repository elsewhere, a stopped or deleted session, a switch turned off, an expired lease and an ended plan, and nothing is written", async () => {
      const a = await rig();
      const second = newKey();
      const secondRunner = await registerKey(h.admin, a.who.accountId, a.who.userId, second);
      // another machine of the account, not the one the repository is placed on
      expect(await report(a, { key: second })).toMatchObject(refusedAs(404, "not_found"));
      // another account's repository is not found either
      const b = await rig();
      expect(await report(a, { body: { repo_gh_id: b.ghRepoId, session_id: b.startId } })).toMatchObject(refusedAs(404, "not_found"));
      // an unknown session, and a session of an older start
      expect(await report(a, { body: { repo_gh_id: a.ghRepoId, session_id: randomUUID() } })).toMatchObject(NOT_RUNNING);
      await h.admin.query("UPDATE machine_jobs SET state = 'done' WHERE id = $1", [a.startId]);
      await start(a, "delivered", 1_000);
      expect(await report(a)).toMatchObject(NOT_RUNNING);
      // the repository moved to the second machine: the first machine's report is refused, and so is the second one with the first one's session
      await h.admin.query("UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1", [a.who.repoId, secondRunner]);
      expect(await report(a)).toMatchObject(refusedAs(404, "not_found"));
      expect(await report(a, { key: second })).toMatchObject(NOT_RUNNING);
      expect(await reportJobs(a)).toHaveLength(0);
      expect(await audits(a)).toBe(0);
      for (const [label, change] of [
        ["a stop issued after the start", async (r: Rig) => void (await later(r, "engine_session_stop", "issued"))],
        ["a delete issued after the start", async (r: Rig) => void (await later(r, "engine_session_delete", "done"))],
        ["operate off", async (r: Rig) => void (await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]))],
        ["a lapsed lease", async (r: Rig) => void (await h.admin.query("UPDATE engine_session_leases SET expires_at = now() - interval '1 minute' WHERE account_id = $1", [r.who.accountId]))],
        ["operate turned off and on again (a new epoch, which needs a new start)", async (r: Rig) => {
          await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
          await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
        }],
        ["an ended plan", async (r: Rig) => void (await h.admin.query("UPDATE accounts SET subscription_ended_at = now() - interval '1 day' WHERE id = $1", [r.who.accountId]))],
        ["an unticked repository", async (r: Rig) => void (await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId]))],
      ] as const) {
        const r = await rig();
        await change(r);
        expect(await report(r), label).toMatchObject(NOT_RUNNING);
        expect((await reportJobs(r)).filter((j) => j.stop_reason === "token_refresh_failed"), label).toHaveLength(0);
      }
    });

    it("takes the message as strictly as the token route, signs with the cloud's key only, and answers 503 with no signer", async () => {
      const a = await rig();
      for (const body of [{ repo_gh_id: a.ghRepoId, session_id: a.startId, reason: "person" }, { repo_gh_id: a.ghRepoId }, { session_id: a.startId }, { repo_gh_id: 0, session_id: a.startId }, { repo_gh_id: a.ghRepoId, session_id: "not-a-uuid" }, {}]) {
        expect((await report(a, { body })).status, JSON.stringify(body)).toBe(400);
      }
      expect(await report(a, { deps: depsFor({ engineCommandSigner: async () => null }) })).toMatchObject(refusedAs(503, "not_configured"));
      expect(await reportJobs(a)).toHaveLength(0);
      const request = signed(a.key, REPO_TOKEN_STOP_PATH, { repo_gh_id: a.ghRepoId, session_id: a.startId });
      expect((await respond(() => engineRepoTokenStopRun(depsFor(), request))).status).toBe(200);
      expect(await respond(() => engineRepoTokenStopRun(depsFor(), request))).toMatchObject(refusedAs(409, "nonce_reused"));
      // a removed machine's key is refused before anything is read
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE account_id = $1", [a.who.accountId]);
      expect((await report(a)).status).toBe(401);
    });

    it("the definer fences by itself: not callable outside a runner session, refuses signed bytes that say anything else, and takes the repository from the bytes only for a placed repository", async () => {
      const a = await rig();
      const issued = new Date();
      const expires = new Date(issued.getTime() + 600_000);
      // the definer holds the signed bytes to the row; it does not verify the signature (the cloud signs), so the bad cases are plain objects
      const bytes = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => {
        const id = randomUUID();
        const job = { job: { v: 1, job_id: id, runner_id: a.runnerId, repo_gh_id: a.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "engine_session_stop", args: { reason: "token_refresh_failed", operate_epoch: 1, ...over }, ...top }, key_id: "job-key-1", sig: "AA" };
        return { id, job };
      };
      const call = async (b: { id: string; job: unknown }, session = a.startId, runner: string | null = a.runnerId): Promise<string> => {
        try {
          return await withTenant(h.appPool, a.who.accountId, async (client) => {
            if (runner !== null) await client.query("SELECT set_config('app.runner_id', $1, true)", [runner]);
            return (await client.query<{ r: string }>("SELECT engine_repo_token_stop_report($1, $2, $3::jsonb, $4, $5) AS r", [b.id, session, JSON.stringify(b.job), issued, expires])).rows[0]!.r;
          });
        } catch (e) {
          return (e as { code?: string }).code ?? `error: ${String((e as Error).message)}`;
        }
      };
      expect(await call(bytes(), a.startId, null)).toBe("42501"); // no runner in the session
      expect(await call(bytes(), a.startId, randomUUID())).toBe("42501"); // a runner that is not one of the account's
      for (const [label, b] of [
        ["another reason", bytes({ reason: "person" })],
        ["another kind", bytes({}, { kind: "engine_session_delete", args: { operate_epoch: 1 } })],
        ["another machine's job", bytes({}, { runner_id: randomUUID() })],
        ["a setup", bytes({}, { setup_id: randomUUID() })],
        ["a job id that is not the row's", { id: randomUUID(), job: bytes().job }],
      ] as const) expect(await call(b), label).toBe("22023");
      expect(await call(bytes({ operate_epoch: 7 }))).toBe("epoch_moved");
      expect(await call(bytes({}, { repo_gh_id: a.ghRepoId + 1 }))).toBe("not_found"); // a repository this account has not got
      expect(await call(bytes(), randomUUID())).toBe("not_running");
      expect(await reportJobs(a)).toHaveLength(0);
      expect(await call(bytes())).toBe("recorded");
      expect(await call(bytes())).toBe("already");
    });
  });

  /** The stop report's definer judges the session again by itself, whatever the route read before it: each condition is turned off on its own, and the definer is called directly as the runner's own session. */
  it("the stop report's definer re-checks the placed runner, the stops and deletes after the start, the lease, the switches and the plan, with the route out of the way", async () => {
    const callAs = async (r: Rig, runner: string, over: { runnerInJob?: string; session?: string } = {}): Promise<string> => {
      const id = randomUUID();
      const issued = new Date();
      const expires = new Date(issued.getTime() + 600_000);
      const job = { job: { v: 1, job_id: id, runner_id: over.runnerInJob ?? runner, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "engine_session_stop", args: { reason: "token_refresh_failed", operate_epoch: 1 } }, key_id: "job-key-1", sig: "AA" };
      return withTenant(h.appPool, r.who.accountId, async (client) => {
        await client.query("SELECT set_config('app.runner_id', $1, true)", [runner]);
        return (await client.query<{ r: string }>("SELECT engine_repo_token_stop_report($1, $2, $3::jsonb, $4, $5) AS r", [id, over.session ?? r.startId, JSON.stringify(job), issued, expires])).rows[0]!.r;
      });
    };
    const written = async (r: Rig) => Number((await h.admin.query("SELECT count(*) AS n FROM machine_jobs WHERE account_id = $1 AND stop_reason = 'token_refresh_failed'", [r.who.accountId])).rows[0].n);
    // a machine of the account that the repository is not placed on, with its own session id of the same repository's start
    const a = await rig();
    const second = await registerKey(h.admin, a.who.accountId, a.who.userId, newKey());
    expect(await callAs(a, second)).toBe("not_found");
    expect(await written(a)).toBe(0);
    // a stop or a delete after the start, in every live state, ends the session for the report too
    const b = await rig({ start: "done" });
    for (const kind of ["engine_session_stop", "engine_session_delete"] as const) {
      for (const state of ["issued", "delivered", "done"]) {
        const id = await later(b, kind, state);
        expect(await callAs(b, b.runnerId), `${kind} ${state}`).toBe("not_running");
        await h.admin.query("DELETE FROM machine_jobs WHERE id = $1", [id]);
      }
    }
    expect(await written(b)).toBe(0);
    // the lease, the switches and the plan
    for (const [label, change] of [
      ["a lapsed lease", (r: Rig) => h.admin.query("UPDATE engine_session_leases SET expires_at = now() - interval '1 minute' WHERE account_id = $1", [r.who.accountId])],
      ["no lease", (r: Rig) => h.admin.query("DELETE FROM engine_session_leases WHERE account_id = $1", [r.who.accountId])],
      ["an unticked repository", (r: Rig) => h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId])],
      ["an ended plan", (r: Rig) => h.admin.query("UPDATE accounts SET subscription_ended_at = now() - interval '1 day' WHERE id = $1", [r.who.accountId])],
      ["operate off", (r: Rig) => h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId])],
    ] as const) {
      const r = await rig();
      await change(r);
      const answer = await callAs(r, r.runnerId).catch((e: { code?: string }) => e.code ?? "error");
      expect(["not_running", "epoch_moved"], label).toContain(answer);
      expect(await written(r), label).toBe(0);
    }
  });

  it("revokes a token it minted and could not hand out", async () => {
    const r = await rig();
    revoked.length = 0;
    const answer = await ask(r, { deps: depsFor({ engineRepoToken: { ...port(), mint: async () => ({ token: "", expiresAt: new Date() }) } }) });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(revoked).toEqual([""]);
  });
});
