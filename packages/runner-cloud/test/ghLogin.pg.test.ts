import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { GH_DEVICE_URL, GH_LOGIN_CAPABILITY, MACHINE_LOGIN_CAPABILITY, MACHINE_ONBOARDING_MIN_PROTOCOL, ghLoginReportPath, machineLoginReportPath, verifyMachineCommand, type MachineCommand } from "@fulcrumaxe/runner-protocol";
import { createJobSigner } from "@fx/runner";
import { CLAIM_PATH, cancelGhLogin, claimRun, ghLoginReportRun, machineLoginReportRun, readGhLogin, signOutOfGh, startGhLogin, startClaudeLogin, readClaudeLogin, type RunnerCloudDeps, type RunnerLeaseOps } from "../src/index.js";
import type { MachineLoginSealer } from "@fx/model-connection";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const KEY_ID = "test-signer-1";
const CODE = "ZX9Q-7WK2";
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=REDACTED&scope=user%3Aprofile&state=REDACTED";
const TOKEN = ["gho", "16C7e42F292c6912E7710c838347Ae178B4a"].join("_");

/** The strict stand-in for the machine_ops sealer (AES-256-GCM, the account, request, runner and purpose as the AAD), recording every plaintext it was asked to seal. */
function fakeSealer(): MachineLoginSealer & { sealed: string[] } {
  const key = randomBytes(32);
  const aad = (i: { accountId: string; requestId: string; runnerId: string }, p: string) => Buffer.from(`${i.accountId}:${i.requestId}:${i.runnerId}:${p}`);
  const sealed: string[] = [];
  return {
    sealed,
    seal(ids, purpose, plain) {
      sealed.push(plain);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(aad(ids, purpose));
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    open(ids, purpose, blob) {
      const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      d.setAAD(aad(ids, purpose));
      d.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

/** [pg] D#845 ON-19c: the GitHub sign-in relay through the real routes' functions, the real claim, and the database under row security as the app login (migration 1125). */
describe("GitHub sign-in relay: start, relay, report, sign out [pg]", () => {
  let h: Harness;
  let signKey: KeyObject;
  let keyring: Record<string, KeyObject>;
  const sealer = fakeSealer();
  const logs: string[] = [];
  beforeAll(async () => {
    h = await harness();
    const pair = generateKeyPairSync("ed25519");
    signKey = pair.privateKey;
    keyring = { [KEY_ID]: pair.publicKey };
  });
  afterAll(() => h.close());
  afterEach(() => vi.restoreAllMocks());

  const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases: idle, engineCommandSigner: async () => createJobSigner({ keyId: KEY_ID, privateKey: signKey }), machineLoginSealer: sealer, log: (l) => logs.push(l), ...over });
  const claim = async (r: Rn, body: unknown = {}) => {
    await h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [r.id]);
    return respond(() => claimRun(deps(), signed(r.key, CLAIM_PATH, body)));
  };
  const commandsOf = (res: { body: unknown }) => ((res.body as { machine_commands?: unknown[] }).machine_commands ?? []).map((c) => verifyMachineCommand(c, keyring, (c as { command: { runner_id: string } }).command.runner_id));

  interface Rn { id: string; key: TestKey; serverId: string | null }
  /** A runner of the account at protocol 22 that lists `caps`, linked to a managed server unless `managed` is false. */
  async function runner(f: F2Fixture, o: { managed?: boolean; caps?: string[]; protocol?: number } = {}): Promise<Rn> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, o.protocol ?? MACHINE_ONBOARDING_MIN_PROTOCOL]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, f.accountId, o.caps ?? [MACHINE_LOGIN_CAPABILITY, GH_LOGIN_CAPABILITY]]);
    let serverId: string | null = null;
    if (o.managed !== false) {
      const cred = (await h.admin.query<{ id: string }>(`SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND removed_at IS NULL`, [f.accountId])).rows[0]?.id
        ?? (await h.admin.query<{ id: string }>(`INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', $3, $4, $5, 1, 'a1b2', $2) RETURNING id`, [f.accountId, f.o1, randomBytes(40), randomBytes(12), randomBytes(48)])).rows[0]!.id;
      const tok = (await h.admin.query<{ id: string }>(`INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, $3, 'subscription', now() + interval '1 hour') RETURNING id`, [f.accountId, f.o1, randomBytes(32).toString("hex")])).rows[0]!.id;
      serverId = (await h.admin.query<{ id: string }>(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, runner_id, status) VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4, $5, 'ready') RETURNING id`, [f.accountId, cred, tok, f.o1, id])).rows[0]!.id;
    }
    return { id, key, serverId };
  }
  const principal = (f: F2Fixture, userId: string) => ({ accountId: f.accountId, userId });
  const start = (f: F2Fixture, userId: string, r: Rn | string) => respond(() => startGhLogin(deps(), principal(f, userId), typeof r === "string" ? r : r.id));
  const read = (f: F2Fixture, userId: string, r: Rn | string) => respond(() => readGhLogin(deps(), principal(f, userId), typeof r === "string" ? r : r.id));
  const cancel = (f: F2Fixture, userId: string, r: Rn) => respond(() => cancelGhLogin(deps(), principal(f, userId), r.id));
  const logout = (f: F2Fixture, userId: string, r: Rn) => respond(() => signOutOfGh(deps(), principal(f, userId), r.id));
  const report = (r: Rn, requestId: string, body: unknown, key = r.key) => respond(() => ghLoginReportRun(deps(), signed(key, ghLoginReportPath(requestId), body), requestId));
  const idOf = (res: { body: unknown }) => (res.body as { request_id: string }).request_id;
  const row = async (id: string) => (await h.admin.query<{ status: string; kind: string; u: boolean; c: boolean; failure_code: string | null }>("SELECT status, kind, auth_url_ct IS NULL AS u, code_ct IS NULL AS c, failure_code FROM machine_login_requests WHERE id = $1", [id])).rows[0]!;
  const cmds = async (runnerId: string) => (await h.admin.query<{ kind: string; state: string; request_id: string | null }>("SELECT kind, state, request_id FROM machine_commands WHERE runner_id = $1 ORDER BY issued_at, id", [runnerId])).rows;
  const OK = { state: "awaiting_code", device_url: GH_DEVICE_URL, user_code: CODE };
  async function awaiting(f: F2Fixture, r: Rn): Promise<string> {
    const id = idOf(await start(f, f.o1, r));
    expect(await report(r, id, OK)).toMatchObject({ status: 200, body: { state: "awaiting_code" } });
    return id;
  }

  it("an owner and an admin start a sign-in; a member, another account, a local machine, a removed runner, a runner without gh_login_v1 and an old protocol are refused, and nothing is queued", async () => {
    const f = await seedF2(h.admin);
    const other = await seedF2(h.admin);
    const r = await runner(f);
    const ok = await start(f, f.o1, r);
    expect(ok).toMatchObject({ status: 200, body: { status: "pending" } });
    expect((await row(idOf(ok))).kind).toBe("github");
    expect((await start(f, f.a1, r)).status).toBe(200);
    expect(await start(f, f.m1, r)).toMatchObject({ status: 403 });
    expect(await start(other, other.o1, r.id)).toMatchObject({ status: 404 });
    expect(await start(f, f.o1, randomUUID())).toMatchObject({ status: 404 });
    expect(await start(f, f.o1, "nope")).toMatchObject({ status: 404 });
    const local = await runner(f, { managed: false });
    expect(await start(f, f.o1, local)).toMatchObject({ status: 409, body: { error: { code: "not_managed_server" } } });
    // A runner that lists only machine_login_v1 (a Claude sign-in build) cannot be asked for a GitHub one.
    const claudeOnly = await runner(f, { caps: [MACHINE_LOGIN_CAPABILITY] });
    const old = await runner(f, { protocol: MACHINE_ONBOARDING_MIN_PROTOCOL - 1 });
    expect(await start(f, f.o1, claudeOnly)).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    expect(await start(f, f.o1, old)).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    const gone = await runner(f);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone.id]);
    expect(await start(f, f.o1, gone)).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" } } });
    expect([...(await cmds(local.id)), ...(await cmds(claudeOnly.id)), ...(await cmds(old.id)), ...(await cmds(gone.id))]).toEqual([]);
    expect(await cmds(r.id)).toEqual([{ kind: "gh_login_start", state: "pending", request_id: idOf(ok) }]);
  });

  it("a double click is one request and one command; a lapsed request makes room for a fresh one; a Claude sign-in on the same machine is a separate request that never answers for it", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const a = idOf(await start(f, f.o1, r));
    expect(idOf(await start(f, f.a1, r))).toBe(a);
    const claude = idOf(await respond(() => startClaudeLogin(deps(), principal(f, f.o1), r.id)));
    expect(claude).not.toBe(a);
    expect((await row(claude)).kind).toBe("claude");
    expect(idOf(await start(f, f.o1, r))).toBe(a);
    expect((await cmds(r.id)).map((c) => c.kind)).toEqual(["gh_login_start", "claude_login_start"]);
    // Each reads its own: the GitHub read never shows the Claude request, nor the Claude read the GitHub one.
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { request_id: a } } });
    expect(await respond(() => readClaudeLogin(deps(), principal(f, f.o1), r.id))).toMatchObject({ body: { request: { request_id: claude } } });
    await h.admin.query("UPDATE machine_login_requests SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [a]);
    await h.admin.query("UPDATE machine_commands SET issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE request_id = $1", [a]);
    const b = idOf(await start(f, f.o1, r));
    expect(b).not.toBe(a);
    expect((await row(a)).status).toBe("expired");
    expect((await row(claude)).status).toBe("pending");
    const r2 = await runner(f);
    const both = await Promise.all([start(f, f.o1, r2), start(f, f.a1, r2)]);
    expect(idOf(both[0]!)).toBe(idOf(both[1]!));
    expect((await h.admin.query("SELECT 1 FROM machine_login_requests WHERE runner_id = $1", [r2.id])).rowCount).toBe(1);
  });

  it("delivers the commands signed, once, to a gh_login_v1 runner only; the start names the request, the logout names none, and an ack closes them", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = idOf(await start(f, f.o1, r));
    expect(await logout(f, f.o1, r)).toMatchObject({ status: 200, body: { kind: "gh_logout", state: "pending" } });
    expect(await logout(f, f.o1, r)).toMatchObject({ status: 200 });
    expect(await cmds(r.id)).toHaveLength(2);
    expect(await logout(f, f.m1, r)).toMatchObject({ status: 403 });
    const got = commandsOf(await claim(r)) as MachineCommand[];
    expect(got.map((c) => c.kind)).toEqual(["gh_login_start", "gh_logout"]);
    expect(got[0]).toMatchObject({ args: { request_id: id }, runner_id: r.id, purpose: "machine_command_v1" });
    expect(got[1]!.args).toEqual({});
    expect(commandsOf(await claim(r))).toEqual([]);
    await claim(r, { machine_acks: [{ command_id: got[0]!.command_id, outcome: "applied" }, { command_id: got[1]!.command_id, outcome: "refused", refusal: "busy" }] });
    expect((await cmds(r.id)).map((c) => c.state)).toEqual(["applied", "refused"]);
    // A runner that lists machine_login_v1 but not gh_login_v1 is never handed a GitHub command (it stays pending), while it still gets a Claude one.
    const claudeOnly = await runner(f, { caps: [MACHINE_LOGIN_CAPABILITY] });
    await h.admin.query("INSERT INTO machine_commands (account_id, runner_id, kind, issued_by, issued_at, expires_at) VALUES ($1, $2, 'gh_logout', $3, now(), now() + interval '300 seconds')", [f.accountId, claudeOnly.id, f.o1]);
    await h.admin.query("INSERT INTO machine_commands (account_id, runner_id, kind, issued_by, issued_at, expires_at) VALUES ($1, $2, 'claude_logout', $3, now(), now() + interval '300 seconds')", [f.accountId, claudeOnly.id, f.o1]);
    expect((commandsOf(await claim(claudeOnly)) as MachineCommand[]).map((c) => c.kind)).toEqual(["claude_logout"]);
    expect((await cmds(claudeOnly.id)).map((c) => `${c.kind}:${c.state}`).sort()).toEqual(["claude_logout:delivered", "gh_logout:pending"]);
    // Another runner's ack changes nothing; an expired command is never delivered.
    const lone = await runner(f);
    const loneCmd = (await logout(f, f.o1, lone)).body as { command_id: string };
    await claim(r, { machine_acks: [{ command_id: loneCmd.command_id, outcome: "applied" }] });
    expect((await cmds(lone.id))[0]!.state).toBe("pending");
    await h.admin.query("UPDATE machine_commands SET issued_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE runner_id = $1", [lone.id]);
    expect(commandsOf(await claim(lone))).toEqual([]);
  });

  it("the relay: only the exact address and an 8-character code are accepted and sealed (together); the owner reads them, a member cannot, and the column holds no plaintext", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = idOf(await start(f, f.o1, r));
    expect(await read(f, f.o1, r)).toMatchObject({ status: 200, body: { request: { request_id: id, status: "pending", device_url: null, user_code: null } } });
    for (const bad of [
      { ...OK, device_url: "https://github.com/login/device/" }, { ...OK, device_url: "https://github.com/login/device?x=1" }, { ...OK, device_url: "http://github.com/login/device" },
      { ...OK, device_url: "https://github.com.evil.example/login/device" }, { ...OK, device_url: "https://evil.example/login/device" }, { ...OK, device_url: CLAUDE_URL },
      { ...OK, user_code: "zx9q-7wk2" }, { ...OK, user_code: "ZX9Q7WK2" }, { ...OK, user_code: TOKEN }, { ...OK, user_code: `${CODE} extra` },
      { state: "awaiting_code" }, { state: "awaiting_code", device_url: GH_DEVICE_URL }, { state: "awaiting_code", user_code: CODE }, { ...OK, state: "done" }, { ...OK, token: TOKEN }, { ...OK, output: "clipboard" },
    ]) expect(await report(r, id, bad), JSON.stringify(bad)).toMatchObject({ status: 400 });
    expect((await row(id)).status).toBe("pending");
    expect(await report(r, id, OK)).toMatchObject({ status: 200 });
    expect(await row(id)).toMatchObject({ status: "awaiting_code", u: false });
    expect(sealer.sealed.filter((s) => s.includes(CODE))).toEqual([`${CODE} ${GH_DEVICE_URL}`]);
    expect(await read(f, f.a1, r)).toMatchObject({ status: 200, body: { request: { status: "awaiting_code", device_url: GH_DEVICE_URL, user_code: CODE } } });
    expect(await read(f, f.m1, r)).toMatchObject({ status: 403 });
    expect((await h.admin.query("SELECT 1 FROM machine_login_requests WHERE id = $1 AND (position(convert_to($2, 'UTF8') IN auth_url_ct) > 0 OR position(convert_to('github.com', 'UTF8') IN auth_url_ct) > 0)", [id, CODE])).rowCount).toBe(0);
    expect(await report(r, id, OK)).toMatchObject({ status: 409 });
    // Fail closed on the way out: a blob that opens but is not the two exact values is never shown.
    for (const odd of [`${CODE} https://evil.example/x`, `${TOKEN} ${GH_DEVICE_URL}`, `${CODE}`, `${CODE} ${GH_DEVICE_URL} more`, `${GH_DEVICE_URL} ${CODE}`]) {
      const f2 = await seedF2(h.admin);
      const r2 = await runner(f2);
      const id2 = idOf(await start(f2, f2.o1, r2));
      const ct = sealer.seal({ accountId: f2.accountId, requestId: id2, runnerId: r2.id }, "auth_url", odd);
      await h.admin.query("UPDATE machine_login_requests SET status = 'awaiting_code', auth_url_ct = $2 WHERE id = $1", [id2, ct]);
      const shown = await read(f2, f2.o1, r2);
      expect(shown, odd).toMatchObject({ status: 200, body: { request: { device_url: null, user_code: null, failure_code: "invalid_relay" } } });
      expect(JSON.stringify(shown.body)).not.toContain(TOKEN);
    }
    // Not shown once the request has lapsed.
    await h.admin.query("UPDATE machine_login_requests SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { status: "expired", device_url: null, user_code: null } } });
    expect(await report(r, id, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 404 });
  });

  it("the report belongs to the request's own kind and runner: a Claude request cannot be reported through the GitHub route (or the other way round), nor another runner's request", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const claude = idOf(await respond(() => startClaudeLogin(deps(), principal(f, f.o1), r.id)));
    expect(await report(r, claude, OK)).toMatchObject({ status: 404 });
    expect((await row(claude)).status).toBe("pending");
    const gh = idOf(await start(f, f.o1, r));
    expect(await respond(() => machineLoginReportRun(deps(), signed(r.key, machineLoginReportPath(gh), { state: "awaiting_code", auth_url: CLAUDE_URL }), gh))).toMatchObject({ status: 404 });
    expect((await row(gh)).status).toBe("pending");
    const stranger = await runner(f);
    expect(await report(stranger, gh, OK)).toMatchObject({ status: 404 });
    const foreign = await seedF2(h.admin);
    const alien = await runner(foreign);
    expect(await report(alien, gh, OK)).toMatchObject({ status: 404 });
    expect(await respond(() => ghLoginReportRun(deps(), { method: "POST", headers: {}, body: Buffer.from(JSON.stringify(OK)) }, gh))).toMatchObject({ status: 401 });
    expect((await row(gh)).status).toBe("pending");
    // The setting is the transaction's own: a Claude report right after a GitHub one is a Claude report again.
    expect(await report(r, gh, OK)).toMatchObject({ status: 200 });
    expect(await respond(() => machineLoginReportRun(deps(), signed(r.key, machineLoginReportPath(claude), { state: "awaiting_code", auth_url: CLAUDE_URL }), claude))).toMatchObject({ status: 200 });
  });

  it("done needs no code typed back: awaiting_code goes to done and drops what was sealed; a Claude request still needs code_ready; failed keeps its word and nothing sealed; the server's own status is not touched", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = await awaiting(f, r);
    expect(await report(r, id, { state: "done" })).toMatchObject({ status: 200, body: { state: "done" } });
    expect(await row(id)).toMatchObject({ status: "done", u: true, c: true });
    // a done said again (a reply was lost) is answered, and changes nothing
    expect(await report(r, id, { state: "done" })).toMatchObject({ status: 200, body: { state: "done" } });
    expect(await row(id)).toMatchObject({ status: "done", u: true, c: true });
    expect(await report(r, id, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 409 });
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { status: "done", device_url: null, user_code: null } } });
    const claude = idOf(await respond(() => startClaudeLogin(deps(), principal(f, f.o1), r.id)));
    await respond(() => machineLoginReportRun(deps(), signed(r.key, machineLoginReportPath(claude), { state: "awaiting_code", auth_url: CLAUDE_URL }), claude));
    expect(await respond(() => machineLoginReportRun(deps(), signed(r.key, machineLoginReportPath(claude), { state: "done" }), claude))).toMatchObject({ status: 409 });
    const f2 = await runner(f);
    const id2 = await awaiting(f, f2);
    expect(await report(f2, id2, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 200 });
    expect(await row(id2)).toMatchObject({ status: "failed", u: true, c: true, failure_code: "login_failed" });
    expect((await h.admin.query<{ status: string }>("SELECT status FROM managed_servers WHERE id = $1", [r.serverId])).rows[0]!.status).toBe("ready");
  });

  it("cancel ends the live request, keeps nothing sealed and withdraws the undelivered command; a second cancel and a member are refused", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = await awaiting(f, r);
    expect(await cancel(f, f.m1, r)).toMatchObject({ status: 403 });
    expect(await cancel(f, f.o1, r)).toMatchObject({ status: 200, body: { request_id: id, status: "failed", failure_code: "cancelled" } });
    expect(await row(id)).toMatchObject({ status: "failed", u: true, c: true, failure_code: "cancelled" });
    // Cancelled before the runner ever took the start: the start is withdrawn and nothing else is queued (the runner never ran anything).
    expect(await cmds(r.id)).toEqual([{ kind: "gh_login_start", state: "cancelled", request_id: id }]);
    expect(await cancel(f, f.o1, r)).toMatchObject({ status: 409, body: { error: { code: "no_login_waiting" } } });
    expect(commandsOf(await claim(r))).toEqual([]);
    // It never touches a Claude request of the same machine.
    const claude = idOf(await respond(() => startClaudeLogin(deps(), principal(f, f.o1), r.id)));
    expect(await cancel(f, f.o1, r)).toMatchObject({ status: 409 });
    expect((await row(claude)).status).toBe("pending");
  });

  it("cancel after the runner took the start queues one gh_logout, which is delivered signed with no request (the runner ends the running sign-in and signs out); asking again queues no second", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = await awaiting(f, r);
    const first = commandsOf(await claim(r)) as MachineCommand[];
    expect(first.map((c) => c.kind)).toEqual(["gh_login_start"]);
    expect(await cancel(f, f.o1, r)).toMatchObject({ status: 200, body: { failure_code: "cancelled" } });
    expect(await row(id)).toMatchObject({ status: "failed", u: true, failure_code: "cancelled" });
    expect(await cmds(r.id)).toEqual([{ kind: "gh_login_start", state: "delivered", request_id: id }, { kind: "gh_logout", state: "pending", request_id: null }]);
    // a second cancel finds nothing live; a sign-out asked for meanwhile is the same pending command
    expect(await cancel(f, f.o1, r)).toMatchObject({ status: 409 });
    expect(await logout(f, f.o1, r)).toMatchObject({ status: 200 });
    expect((await cmds(r.id)).filter((c) => c.kind === "gh_logout")).toHaveLength(1);
    const next = commandsOf(await claim(r)) as MachineCommand[];
    expect(next.map((c) => c.kind)).toEqual(["gh_logout"]);
    expect(next[0]!.args).toEqual({});
    // A member's cancel queues nothing; another runner of the account gets nothing.
    const g = await runner(f);
    const id2 = await awaiting(f, g);
    await claim(g);
    expect(await cancel(f, f.m1, g)).toMatchObject({ status: 403 });
    expect((await cmds(g.id)).map((c) => c.kind)).toEqual(["gh_login_start"]);
    expect(id2).not.toBe(id);
  });

  it("a cancel of an undelivered request queues no gh_logout, even after an earlier start on the same runner was delivered and cancelled", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const first = idOf(await start(f, f.o1, r));
    expect((commandsOf(await claim(r)) as MachineCommand[]).map((c) => c.kind)).toEqual(["gh_login_start"]);
    await cancel(f, f.o1, r);
    const out = commandsOf(await claim(r)) as MachineCommand[];
    expect(out.map((c) => c.kind)).toEqual(["gh_logout"]);
    await claim(r, { machine_acks: [{ command_id: out[0]!.command_id, outcome: "applied" }] });
    const second = idOf(await start(f, f.o1, r));
    expect(second).not.toBe(first);
    expect(await cancel(f, f.o1, r)).toMatchObject({ status: 200 });
    expect((await cmds(r.id)).map((c) => `${c.kind}:${c.state}`)).toEqual(["gh_login_start:delivered", "gh_logout:applied", "gh_login_start:cancelled"]);
    expect(commandsOf(await claim(r))).toEqual([]);
  });

  it("the runner's closed failure words: already_signed_in is stored and shown to the owner; an unknown word is refused; signout_failed is taken for a cancelled or refused-done request and the owner sees it, but never for a Claude request or a live-less one", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = idOf(await start(f, f.o1, r));
    expect(await report(r, id, { state: "failed", failure_code: "some_gh_text_with_a_token" })).toMatchObject({ status: 400 });
    expect(await report(r, id, { state: "failed", failure_code: "already_signed_in" })).toMatchObject({ status: 200 });
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { status: "failed", failure_code: "already_signed_in", device_url: null, user_code: null } } });
    // a cancelled request is told the sign-out failed
    const g = await runner(f);
    const id2 = await awaiting(f, g);
    await cancel(f, f.o1, g);
    expect(await report(g, id2, { state: "failed", failure_code: "signout_failed" })).toMatchObject({ status: 200 });
    expect(await read(f, f.o1, g)).toMatchObject({ body: { request: { status: "failed", failure_code: "signout_failed" } } });
    expect(await row(id2)).toMatchObject({ u: true, c: true });
    // a request that was done is not told this; a failed one repeats its own word and gets 200
    const k = await runner(f);
    const id3 = await awaiting(f, k);
    expect(await report(k, id3, { state: "done" })).toMatchObject({ status: 200 });
    // signout_failed is taken from a request that failed (the states a runner path reaches), not from one that is done
    expect(await report(k, id3, { state: "failed", failure_code: "signout_failed" })).toMatchObject({ status: 409 });
    expect((await row(id3)).status).toBe("done");
    expect(await report(g, id2, { state: "failed", failure_code: "signout_failed" })).toMatchObject({ status: 200 });
    // no other word gets this latitude on a finished request, and a Claude request gets none
    expect(await report(k, id3, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 409 });
    const claude = idOf(await respond(() => startClaudeLogin(deps(), principal(f, f.o1), k.id)));
    await respond(() => machineLoginReportRun(deps(), signed(k.key, machineLoginReportPath(claude), { state: "failed", failure_code: "login_failed" }), claude));
    expect(await respond(() => machineLoginReportRun(deps(), signed(k.key, machineLoginReportPath(claude), { state: "failed", failure_code: "signout_failed" }), claude))).toMatchObject({ status: 409 });
    // another runner's request is not reachable this way
    expect(await report(g, id3, { state: "failed", failure_code: "signout_failed" })).toMatchObject({ status: 404 });
  });

  it("a terminal report said again answers 200 and changes nothing (a retried done after a lost reply never reads as a cancelled request); a different end or word is still refused; a Claude request keeps its 409", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const failedId = idOf(await start(f, f.o1, r));
    expect(await report(r, failedId, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 200 });
    expect(await report(r, failedId, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 200 });
    expect(await report(r, failedId, { state: "failed", failure_code: "timeout" })).toMatchObject({ status: 409 });
    expect(await report(r, failedId, { state: "failed" })).toMatchObject({ status: 409 });
    expect(await report(r, failedId, { state: "done" })).toMatchObject({ status: 409 });
    expect((await row(failedId)).failure_code).toBe("login_failed");
    // a done after a cancel is the refused one: it is NOT the same end, so the runner's fail-safe still runs
    const g = await runner(f);
    const id = await awaiting(f, g);
    await cancel(f, f.o1, g);
    expect(await report(g, id, { state: "done" })).toMatchObject({ status: 409 });
    // the Claude route's own rule is unchanged: a done said again is refused
    const c = await runner(f);
    const claude = idOf(await respond(() => startClaudeLogin(deps(), principal(f, f.o1), c.id)));
    await respond(() => machineLoginReportRun(deps(), signed(c.key, machineLoginReportPath(claude), { state: "failed", failure_code: "login_failed" }), claude));
    expect(await respond(() => machineLoginReportRun(deps(), signed(c.key, machineLoginReportPath(claude), { state: "failed", failure_code: "login_failed" }), claude))).toMatchObject({ status: 409 });
  });

  it("a GitHub request is never a Claude sign-in: the Claude read of the same machine shows none of it", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    await awaiting(f, r);
    expect(await respond(() => readClaudeLogin(deps(), principal(f, f.o1), r.id))).toMatchObject({ status: 200, body: { request: null } });
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { status: "awaiting_code" } } });
  });

  it("tenant and runner filters: a second runner of the same account and a foreign account see and change none of another runner's requests or commands", async () => {
    const f = await seedF2(h.admin);
    const foreign = await seedF2(h.admin);
    const a = await runner(f);
    const b = await runner(f);
    const id = await awaiting(f, a);
    expect(await read(f, f.o1, b)).toMatchObject({ body: { request: null } });
    expect(await read(foreign, foreign.o1, a.id)).toMatchObject({ status: 404 });
    expect(await cancel(foreign, foreign.o1, a)).toMatchObject({ status: 404 });
    expect(await logout(foreign, foreign.o1, a)).toMatchObject({ status: 404 });
    // The RLS-bypassing client with a foreign account id still finds no row through the route's own predicates.
    const rows = await h.admin.query("SELECT 1 FROM machine_login_requests WHERE id = $1 AND account_id = $2", [id, foreign.accountId]);
    expect(rows.rowCount).toBe(0);
    expect(await cancel(f, f.o1, b)).toMatchObject({ status: 409 });
    expect((await row(id)).status).toBe("awaiting_code");
    // The claim of the other runner brings none of a's commands.
    expect(commandsOf(await claim(b))).toEqual([]);
    expect((await cmds(a.id))[0]!.state).toBe("pending");
  });

  it("nothing but the two values is anywhere: the code is in no table (the sealed column is bytes), no log line, no audit row, no command row, and no response but the owner's read", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const sealedBefore = sealer.sealed.length;
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const responses: unknown[] = [];
    const id = idOf(await start(f, f.o1, r));
    responses.push(await report(r, id, OK), await cancel(f, f.m1, r), await logout(f, f.o1, r), await claim(r));
    const audit = (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'machine.login_started'", [f.accountId])).rows;
    expect(audit).toEqual([{ payload: { request_id: id, runner_id: r.id } }]);
    const shown = await read(f, f.o1, r);
    expect(JSON.stringify(shown.body)).toContain(CODE);
    expect(JSON.stringify(responses)).not.toContain(CODE);
    const hex = Buffer.from(CODE).toString("hex");
    const tables = (await h.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((t) => t.tablename);
    for (const t of tables) {
      const hit = await h.admin.query(`SELECT 1 FROM "${t}" x WHERE x::text LIKE '%' || $1 || '%' OR x::text LIKE '%' || $2 || '%' LIMIT 1`, [CODE, hex]);
      expect(hit.rowCount, `table ${t}`).toBe(0);
    }
    expect(logs.join("\n")).not.toContain(CODE);
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(CODE);
    expect(sealer.sealed.slice(sealedBefore)).toEqual([`${CODE} ${GH_DEVICE_URL}`]);
  });
});
