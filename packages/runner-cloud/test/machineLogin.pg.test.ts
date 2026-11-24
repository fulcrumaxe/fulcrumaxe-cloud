import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { sha256Hex } from "@fx/db/test/helpers/runnerFixtures.js";
import { MACHINE_LOGIN_CAPABILITY, MACHINE_ONBOARDING_MIN_PROTOCOL, machineLoginCodePath, machineLoginReportPath, verifyMachineCommand, type MachineCommand } from "@fulcrumaxe/runner-protocol";
import { createJobSigner } from "@fx/runner";
import {
  CLAIM_PATH, cancelClaudeLogin, claimRun, machineLoginCodeRun, machineLoginReportRun, readClaudeLogin, signOutOfClaude, startClaudeLogin, submitClaudeLoginCode,
  type RunnerCloudDeps, type RunnerLeaseOps,
} from "../src/index.js";
import type { MachineLoginSealer } from "@fx/model-connection";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const KEY_ID = "test-signer-1";
const URL_OK = "https://claude.com/cai/oauth/authorize?code=true&client_id=REDACTED&scope=user%3Aprofile+user%3Ainference&state=REDACTED";
const SENTINEL = "SENTINELcode9Z8y7X";
const MIXED_CODE = "MIXEDcase5W4v3U";

/**
 * A strict stand-in for the machine_ops sealer: AES-256-GCM with the account, request, runner and purpose as the AAD, so a blob moved to another request, runner, account or purpose does not
 * open, exactly as the real one (model-connection's machineOps; its own test holds that one). It records every plaintext it was asked to seal, so a test can say where that text must not be.
 */
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

/** [pg] D#845 MC-8a: the Claude sign-in link through the real routes' functions, the real claim, and the database under row security as the app login (migration 1070). */
describe("machine login: start, link, code, report, sign out [pg]", () => {
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
  /** A runner of the account that lists machine_login_v1 at protocol 22, linked to a managed server in `needs_claude_login` unless `managed` is false. */
  async function runner(f: F2Fixture, o: { managed?: boolean; capable?: boolean; protocol?: number } = {}): Promise<Rn> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, o.protocol ?? MACHINE_ONBOARDING_MIN_PROTOCOL]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, f.accountId, o.capable === false ? [] : [MACHINE_LOGIN_CAPABILITY]]);
    let serverId: string | null = null;
    if (o.managed !== false) {
      const cred = (await h.admin.query<{ id: string }>(`SELECT id FROM machine_provider_credentials WHERE account_id = $1 AND removed_at IS NULL`, [f.accountId])).rows[0]?.id
        ?? (await h.admin.query<{ id: string }>(`INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', $3, $4, $5, 1, 'a1b2', $2) RETURNING id`, [f.accountId, f.o1, randomBytes(8), randomBytes(12), randomBytes(60)])).rows[0]!.id;
      const tok = (await h.admin.query<{ id: string }>(`INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, $3, 'subscription', now() + interval '1 hour') RETURNING id`, [f.accountId, f.o1, sha256Hex()])).rows[0]!.id;
      serverId = (await h.admin.query<{ id: string }>(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, runner_id, status) VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4, $5, 'needs_claude_login') RETURNING id`, [f.accountId, cred, tok, f.o1, id])).rows[0]!.id;
    }
    return { id, key, serverId };
  }
  const principal = (f: F2Fixture, userId: string) => ({ accountId: f.accountId, userId });
  const start = (f: F2Fixture, userId: string, r: Rn | string) => respond(() => startClaudeLogin(deps(), principal(f, userId), typeof r === "string" ? r : r.id));
  const read = (f: F2Fixture, userId: string, r: Rn) => respond(() => readClaudeLogin(deps(), principal(f, userId), r.id));
  const submit = (f: F2Fixture, userId: string, r: Rn, body: unknown) => respond(() => submitClaudeLoginCode(deps(), principal(f, userId), r.id, body));
  const report = (r: Rn, requestId: string, body: unknown, key = r.key) => respond(() => machineLoginReportRun(deps(), signed(key, machineLoginReportPath(requestId), body), requestId));
  const take = (r: Rn, requestId: string, key = r.key) => respond(() => machineLoginCodeRun(deps(), signed(key, machineLoginCodePath(requestId), "", { method: "GET", rawBody: Buffer.alloc(0) }), requestId));
  const requestIdOf = (res: { body: unknown }) => (res.body as { request_id: string }).request_id;
  const reqRow = async (id: string) => (await h.admin.query<{ status: string; u: boolean; c: boolean; failure_code: string | null }>("SELECT status, auth_url_ct IS NULL AS u, code_ct IS NULL AS c, failure_code FROM machine_login_requests WHERE id = $1", [id])).rows[0]!;
  const cmds = async (runnerId: string) => (await h.admin.query<{ kind: string; state: string; request_id: string | null; refusal: string | null }>("SELECT kind, state, request_id, refusal FROM machine_commands WHERE runner_id = $1 ORDER BY issued_at, id", [runnerId])).rows;

  /** A request taken to `awaiting_code`. */
  async function awaiting(f: F2Fixture, r: Rn): Promise<string> {
    const id = requestIdOf(await start(f, f.o1, r));
    expect(await report(r, id, { state: "awaiting_code", auth_url: URL_OK })).toMatchObject({ status: 200, body: { state: "awaiting_code" } });
    return id;
  }

  it("an owner and an admin start a sign-in; a member, another account, a local machine, a removed runner and a runner that cannot do it are refused, and nothing is queued", async () => {
    const f = await seedF2(h.admin);
    const other = await seedF2(h.admin);
    const r = await runner(f);
    const ok = await start(f, f.o1, r);
    expect(ok).toMatchObject({ status: 200, body: { status: "pending" } });
    expect((await start(f, f.a1, r)).status).toBe(200);
    expect(await start(f, f.m1, r)).toMatchObject({ status: 403 });
    expect(await start(other, other.o1, r.id)).toMatchObject({ status: 404 });
    expect(await start(f, f.o1, randomUUID())).toMatchObject({ status: 404 });
    expect(await start(f, f.o1, "nope")).toMatchObject({ status: 404 });
    const local = await runner(f, { managed: false });
    expect(await start(f, f.o1, local)).toMatchObject({ status: 409, body: { error: { code: "not_managed_server" } } });
    const nocap = await runner(f, { capable: false });
    const old = await runner(f, { protocol: MACHINE_ONBOARDING_MIN_PROTOCOL - 1 });
    expect(await start(f, f.o1, nocap)).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    expect(await start(f, f.o1, old)).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    const gone = await runner(f);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone.id]);
    expect(await start(f, f.o1, gone)).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" } } });
    // A server that is being deleted is no managed server.
    const deleting = await runner(f);
    await h.admin.query("UPDATE managed_servers SET status = 'deleting' WHERE id = $1", [deleting.serverId]);
    expect(await start(f, f.o1, deleting)).toMatchObject({ status: 409, body: { error: { code: "not_managed_server" } } });
    expect([...(await cmds(local.id)), ...(await cmds(nocap.id)), ...(await cmds(old.id)), ...(await cmds(gone.id)), ...(await cmds(deleting.id))]).toEqual([]);
    expect(await cmds(r.id)).toEqual([{ kind: "claude_login_start", state: "pending", request_id: requestIdOf(ok), refusal: null }]);
  });

  it("a double click is one request and one command; a finished or lapsed request makes room for a fresh one", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const a = requestIdOf(await start(f, f.o1, r));
    expect(requestIdOf(await start(f, f.a1, r))).toBe(a);
    expect(await cmds(r.id)).toHaveLength(1);
    await h.admin.query("UPDATE machine_login_requests SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [a]);
    await h.admin.query("UPDATE machine_commands SET issued_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE request_id = $1", [a]);
    const b = requestIdOf(await start(f, f.o1, r));
    expect(b).not.toBe(a);
    expect((await reqRow(a)).status).toBe("expired");
    // Two at once: one request.
    const r2 = await runner(f);
    const both = await Promise.all([start(f, f.o1, r2), start(f, f.a1, r2)]);
    expect(requestIdOf(both[0]!)).toBe(requestIdOf(both[1]!));
    // The same account's other runner has its own request: a live request of one machine is never the answer for another.
    expect(requestIdOf(both[0]!)).not.toBe(b);
    expect((await h.admin.query("SELECT 1 FROM machine_login_requests WHERE runner_id = $1", [r2.id])).rowCount).toBe(1);
  });

  it("a new request writes one machine.login_started audit row with ids only; the live one returned on a repeat writes nothing", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const rows = async () => (await h.admin.query<{ actor: string | null; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'machine.login_started' ORDER BY created_at", [f.accountId])).rows;
    const a = requestIdOf(await start(f, f.o1, r));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.payload).toEqual({ request_id: a, runner_id: r.id });
    expect(requestIdOf(await start(f, f.a1, r))).toBe(a);
    expect(await rows()).toHaveLength(1);
    // A refused start writes nothing, and the text of the link and the code is in no audit row.
    expect(await start(f, f.m1, r)).toMatchObject({ status: 403 });
    expect(await rows()).toHaveLength(1);
    await h.admin.query("UPDATE machine_login_requests SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [a]);
    const b = requestIdOf(await start(f, f.o1, r));
    expect((await rows()).map((x) => x.payload.request_id)).toEqual([a, b]);
    expect(JSON.stringify(await rows())).not.toContain("claude.com");
  });

  it("an id in upper case is the same runner: two mixed-case starts are one live request, and a code sealed through a mixed-case path opens for the runner", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const both = await Promise.all([start(f, f.o1, r.id.toUpperCase()), start(f, f.a1, r.id), start(f, f.o1, r.id.slice(0, 18).toUpperCase() + r.id.slice(18))]);
    for (const x of both) expect(x.status).toBe(200);
    const id = requestIdOf(both[0]!);
    expect(both.map(requestIdOf)).toEqual([id, id, id]);
    expect((await h.admin.query("SELECT 1 FROM machine_login_requests WHERE runner_id = $1", [r.id])).rowCount).toBe(1);
    expect(await cmds(r.id)).toHaveLength(1);
    expect(await report(r, id, { state: "awaiting_code", auth_url: URL_OK })).toMatchObject({ status: 200 });
    const upper = r.id.toUpperCase();
    expect(await respond(() => readClaudeLogin(deps(), principal(f, f.o1), upper))).toMatchObject({ status: 200, body: { request: { auth_url: URL_OK } } });
    expect(await respond(() => submitClaudeLoginCode(deps(), principal(f, f.o1), upper, { code: MIXED_CODE }))).toMatchObject({ status: 200, body: { status: "code_ready" } });
    expect(await take(r, id)).toMatchObject({ status: 200, body: { code: MIXED_CODE } });
  });

  it("delivers the commands signed, once, to a capable runner only; the start names the request, the logout names none, and an ack closes them", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const nocap = await runner(f, { capable: false });
    const id = requestIdOf(await start(f, f.o1, r));
    await start(f, f.o1, nocap).catch(() => undefined);
    expect(await signOutOfClaude(deps(), principal(f, f.o1), r.id)).toMatchObject({ status: 200, body: { kind: "claude_logout", state: "pending" } });
    expect(await signOutOfClaude(deps(), principal(f, f.m1), r.id).catch((e) => e)).toMatchObject({ status: 403 });
    const first = await claim(r);
    const got = commandsOf(first) as MachineCommand[];
    expect(got.map((c) => c.kind)).toEqual(["claude_login_start", "claude_logout"]);
    expect(got[0]).toMatchObject({ args: { request_id: id }, runner_id: r.id, purpose: "machine_command_v1" });
    expect(got[1]!.args).toEqual({});
    expect(commandsOf(await claim(r))).toEqual([]);
    expect((await cmds(r.id)).map((c) => c.state)).toEqual(["delivered", "delivered"]);
    await claim(r, { machine_acks: [{ command_id: got[0]!.command_id, outcome: "applied" }, { command_id: got[1]!.command_id, outcome: "refused", refusal: "failed" }, { command_id: randomUUID(), outcome: "applied" }] });
    expect(await cmds(r.id)).toMatchObject([{ state: "applied" }, { state: "refused", refusal: "failed" }]);
    // Another runner's ack of this runner's command changes nothing.
    const lone = await runner(f);
    const loneCmd = (await signOutOfClaude(deps(), principal(f, f.o1), lone.id)).body as { command_id: string };
    const other = await runner(f);
    const held = await runner(f);
    const heldCmd = (await signOutOfClaude(deps(), principal(f, f.o1), held.id)).body as { command_id: string };
    expect(commandsOf(await claim(held))).toHaveLength(1);
    await claim(other, { machine_acks: [{ command_id: loneCmd.command_id, outcome: "applied" }, { command_id: heldCmd.command_id, outcome: "applied" }] });
    expect((await cmds(lone.id))[0]!.state).toBe("pending");
    expect((await cmds(held.id))[0]!.state).toBe("delivered");
    // A runner that lists no machine_login_v1 gets none; without a signing key nothing is delivered and nothing is lost.
    await h.admin.query("INSERT INTO machine_commands (account_id, runner_id, kind, issued_by, issued_at, expires_at) VALUES ($1, $2, 'claude_logout', $3, now(), now() + interval '300 seconds')", [f.accountId, nocap.id, f.o1]);
    expect(commandsOf(await claim(nocap))).toEqual([]);
    expect((await h.admin.query<{ state: string }>("SELECT state FROM machine_commands WHERE runner_id = $1", [nocap.id])).rows[0]!.state).toBe("pending");
    expect(commandsOf(await respond(() => claimRun(deps({ engineCommandSigner: async () => null }), signed(lone.key, CLAIM_PATH, {}))))).toEqual([]);
    expect((await cmds(lone.id))[0]!.state).toBe("pending");
    // An expired command is never delivered.
    await h.admin.query("UPDATE machine_commands SET issued_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE runner_id = $1", [lone.id]);
    expect(commandsOf(await claim(lone))).toEqual([]);
    expect((await cmds(lone.id))[0]!.state).toBe("expired");
  });

  it("the link: only the claude.com origin is accepted and sealed; the owner reads it, a member cannot, and the sealed column is no plaintext", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = requestIdOf(await start(f, f.o1, r));
    expect(await read(f, f.o1, r)).toMatchObject({ status: 200, body: { request: { request_id: id, status: "pending", auth_url: null } } });
    for (const bad of ["https://claude.ai/oauth/authorize?x=1", "https://console.anthropic.com/login/x", "https://claude.com.evil.example/x", "https://claude.com@evil.example/x", "http://claude.com/x", "https://evil.example/x", "javascript:alert(1)", "https://claude.com/a b"]) {
      expect(await report(r, id, { state: "awaiting_code", auth_url: bad }), bad).toMatchObject({ status: 400 });
    }
    expect(await report(r, id, { state: "awaiting_code" })).toMatchObject({ status: 400 });
    expect(await report(r, id, { state: "done", auth_url: URL_OK })).toMatchObject({ status: 400 });
    expect((await reqRow(id)).status).toBe("pending");
    expect(await report(r, id, { state: "awaiting_code", auth_url: URL_OK })).toMatchObject({ status: 200 });
    expect(await reqRow(id)).toMatchObject({ status: "awaiting_code", u: false });
    expect(await read(f, f.a1, r)).toMatchObject({ status: 200, body: { request: { status: "awaiting_code", auth_url: URL_OK } } });
    expect(await read(f, f.m1, r)).toMatchObject({ status: 403 });
    expect((await h.admin.query("SELECT 1 FROM machine_login_requests WHERE id = $1 AND position(convert_to('claude.com', 'UTF8') IN auth_url_ct) > 0", [id])).rowCount).toBe(0);
    // A second report of the same state is not a transition.
    expect(await report(r, id, { state: "awaiting_code", auth_url: URL_OK })).toMatchObject({ status: 409 });
    // The link is not shown once the request has lapsed.
    await h.admin.query("UPDATE machine_login_requests SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { status: "expired", auth_url: null } } });
    expect(await report(r, id, { state: "failed", failure_code: "login_failed" })).toMatchObject({ status: 404 });
  });

  it("the code: sealed, handed to the runner once (a second ask is 410), never before it is typed, and the whole database holds it nowhere in the clear", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = await awaiting(f, r);
    expect(await take(r, id)).toMatchObject({ status: 410 });
    expect(await submit(f, f.m1, r, { code: SENTINEL })).toMatchObject({ status: 403 });
    for (const bad of [{}, { code: "" }, { code: "a b" }, { code: SENTINEL, extra: 1 }, { code: 5 }, null, "x"]) expect(await submit(f, f.o1, r, bad), JSON.stringify(bad)).toMatchObject({ status: 400 });
    const typed = await submit(f, f.o1, r, { code: SENTINEL });
    expect(typed).toMatchObject({ status: 200, body: { request_id: id, status: "code_ready" } });
    expect(JSON.stringify(typed.body)).not.toContain(SENTINEL);
    expect(await submit(f, f.o1, r, { code: SENTINEL })).toMatchObject({ status: 409, body: { error: { code: "no_login_waiting" } } });
    expect(await read(f, f.o1, r)).toMatchObject({ body: { request: { status: "code_ready", auth_url: null } } });
    // Another runner of the same account cannot take it; nor can an unsigned request.
    const stranger = await runner(f);
    expect(await take(stranger, id)).toMatchObject({ status: 410 });
    expect(await respond(() => machineLoginCodeRun(deps(), { method: "GET", headers: {}, body: Buffer.alloc(0) }, id))).toMatchObject({ status: 401 });
    expect((await reqRow(id)).c).toBe(false);
    const delivered = commandsOf(await claim(r)) as MachineCommand[];
    expect(delivered.map((c) => c.kind)).toEqual(["claude_login_start", "claude_login_code"]);
    const got = await take(r, id);
    expect(got).toMatchObject({ status: 200, body: { code: SENTINEL } });
    expect(await take(r, id)).toMatchObject({ status: 410 });
    expect((await reqRow(id)).c).toBe(true);
    // The code is in no row of any table (as text or as the bytes of a bytea), no log line, no response but the one fetch, and no seal was made of anything but the link and the code.
    const hex = Buffer.from(SENTINEL).toString("hex");
    const tables = (await h.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((t) => t.tablename);
    for (const t of tables) {
      const hit = await h.admin.query(`SELECT 1 FROM "${t}" x WHERE x::text LIKE '%' || $1 || '%' OR x::text LIKE '%' || $2 || '%' LIMIT 1`, [SENTINEL, hex]);
      expect(hit.rowCount, `table ${t}`).toBe(0);
    }
    expect(logs.join("\n")).not.toContain(SENTINEL);
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SENTINEL);
    expect(sealer.sealed.filter((s) => s === SENTINEL)).toHaveLength(1);
  });

  it("success moves the request to done, drops what was sealed and readies the server that waited for its sign-in; a failure keeps its word and nothing sealed", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = await awaiting(f, r);
    expect(await report(r, id, { state: "done" })).toMatchObject({ status: 409 });
    await submit(f, f.o1, r, { code: "abc123" });
    expect(await report(r, id, { state: "done" })).toMatchObject({ status: 200, body: { state: "done" } });
    expect(await reqRow(id)).toMatchObject({ status: "done", u: true, c: true });
    expect((await h.admin.query<{ status: string }>("SELECT status FROM managed_servers WHERE id = $1", [r.serverId])).rows[0]!.status).toBe("ready");
    expect(await report(r, id, { state: "done" })).toMatchObject({ status: 409 });
    const f2 = await runner(f);
    const id2 = await awaiting(f, f2);
    expect(await report(f2, id2, { state: "failed", failure_code: "login_timeout" })).toMatchObject({ status: 200 });
    expect(await reqRow(id2)).toMatchObject({ status: "failed", u: true, c: true, failure_code: "login_timeout" });
    expect(await read(f, f.o1, f2)).toMatchObject({ body: { request: { status: "failed", failure_code: "login_timeout", auth_url: null } } });
    expect((await h.admin.query<{ status: string }>("SELECT status FROM managed_servers WHERE id = $1", [f2.serverId])).rows[0]!.status).toBe("needs_claude_login");
    // Another runner cannot report on this runner's request.
    const id3 = requestIdOf(await start(f, f.o1, f2));
    expect(await report(r, id3, { state: "failed" })).toMatchObject({ status: 404 });
    expect((await reqRow(id3)).status).toBe("pending");
  });

  it("cancel ends the live request, withdraws its undelivered commands and keeps nothing sealed; only an owner or admin can", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const sibling = await runner(f);
    const siblingId = await awaiting(f, sibling);
    const id = await awaiting(f, r);
    await submit(f, f.o1, r, { code: SENTINEL });
    expect(await respond(() => cancelClaudeLogin(deps(), principal(f, f.m1), r.id))).toMatchObject({ status: 403 });
    expect(await respond(() => cancelClaudeLogin(deps(), principal(f, f.a1), r.id))).toMatchObject({ status: 200, body: { status: "failed", failure_code: "cancelled" } });
    expect(await reqRow(id)).toMatchObject({ status: "failed", u: true, c: true, failure_code: "cancelled" });
    expect((await cmds(r.id)).map((c) => c.state)).toEqual(["cancelled", "cancelled"]);
    expect(await respond(() => cancelClaudeLogin(deps(), principal(f, f.o1), r.id))).toMatchObject({ status: 409, body: { error: { code: "no_login_waiting" } } });
    expect(await take(r, id)).toMatchObject({ status: 410 });
    // The account's other machine keeps its sign-in, link and commands.
    expect(await reqRow(siblingId)).toMatchObject({ status: "awaiting_code", u: false });
    expect((await cmds(sibling.id)).map((c) => c.state)).toEqual(["pending"]);
  });

  it("a sealed value moved to another request, runner or account does not open: the AAD binds all four", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const idA = await awaiting(f, r);
    const r2 = await runner(f);
    const idB = await awaiting(f, r2);
    // The link of request A copied onto request B (same account, other runner and request): reading B's link fails closed (a fixed 503), and shows no link.
    await h.admin.query("UPDATE machine_login_requests b SET auth_url_ct = a.auth_url_ct FROM machine_login_requests a WHERE a.id = $1 AND b.id = $2", [idA, idB]);
    expect(await read(f, f.o1, r2)).toMatchObject({ status: 503, body: { error: { code: "not_configured" } } });
    // The code of A copied onto B: the runner's one fetch fails closed and says nothing of the key.
    await submit(f, f.o1, r, { code: "abc123" });
    await submit(f, f.o1, r2, { code: "zzz999" });
    await h.admin.query("UPDATE machine_login_requests b SET code_ct = a.code_ct FROM machine_login_requests a WHERE a.id = $1 AND b.id = $2", [idA, idB]);
    expect(await take(r2, idB)).toMatchObject({ status: 503 });
    // The sealer itself: another purpose, account, request or runner fails.
    const ids = { accountId: f.accountId, requestId: idA, runnerId: r.id };
    const blob = sealer.seal(ids, "code", "x");
    expect(sealer.open(ids, "code", blob)).toBe("x");
    for (const moved of [{ ...ids, accountId: randomUUID() }, { ...ids, requestId: randomUUID() }, { ...ids, runnerId: randomUUID() }]) expect(() => sealer.open(moved, "code", blob)).toThrow();
    expect(() => sealer.open(ids, "auth_url", blob)).toThrow();
  });

  it("without the machine key nothing is stored or opened: the sign-in routes answer 503", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    expect(await respond(() => startClaudeLogin(deps({ machineLoginSealer: null }), principal(f, f.o1), r.id))).toMatchObject({ status: 503, body: { error: { code: "not_configured" } } });
    const id = requestIdOf(await start(f, f.o1, r));
    const broken: MachineLoginSealer = { seal: () => { throw new Error("machine_kek_unset"); }, open: () => { throw new Error("machine_kek_unset"); } };
    expect(await respond(() => machineLoginReportRun(deps({ machineLoginSealer: broken }), signed(r.key, machineLoginReportPath(id), { state: "awaiting_code", auth_url: URL_OK }), id))).toMatchObject({ status: 503 });
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("the database refuses what the routes would never ask: a runner session writes no request and reads no sealed column, a member writes nothing, and the definers hold their sessions", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const id = await awaiting(f, r);
    await submit(f, f.o1, r, { code: "abc123" });
    const as = async (who: { user?: string; runner?: string }, sql: string, params: unknown[] = []) => {
      const c = await h.appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
        if (who.user) await c.query("SELECT set_config('app.user_id', $1, true)", [who.user]);
        if (who.runner) await c.query("SELECT set_config('app.runner_id', $1, true)", [who.runner]);
        return await c.query(sql, params);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    // No role reads a sealed column directly.
    for (const who of [{ user: f.o1 }, { runner: r.id }]) await expect(as(who, "SELECT auth_url_ct FROM machine_login_requests")).rejects.toMatchObject({ code: "42501" });
    for (const who of [{ user: f.o1 }, { runner: r.id }]) await expect(as(who, "SELECT code_ct FROM machine_login_requests")).rejects.toMatchObject({ code: "42501" });
    // A runner session writes nothing in the table, a member neither, and an owner changes only what the grant names.
    expect((await as({ runner: r.id }, "UPDATE machine_login_requests SET status = 'done' WHERE id = $1", [id])).rowCount).toBe(0);
    expect((await as({ user: f.m1 }, "UPDATE machine_login_requests SET status = 'failed' WHERE id = $1", [id])).rowCount).toBe(0);
    await expect(as({ user: f.m1 }, "INSERT INTO machine_login_requests (account_id, runner_id, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')", [f.accountId, r.id, f.m1])).rejects.toMatchObject({ code: "42501" });
    await expect(as({ user: f.o1 }, "UPDATE machine_login_requests SET runner_id = $2 WHERE id = $1", [id, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    // The definers: the runner's two only inside a runner session, the person's only outside one.
    await expect(as({ user: f.o1 }, "SELECT machine_login_code_take($1)", [id])).rejects.toMatchObject({ code: "42501" });
    await expect(as({ user: f.o1 }, "SELECT machine_login_report($1, 'done', NULL, NULL)", [id])).rejects.toMatchObject({ code: "42501" });
    await expect(as({ runner: r.id }, "SELECT machine_login_auth_url($1)", [id])).rejects.toMatchObject({ code: "42501" });
    await expect(as({ runner: r.id }, "SELECT machine_login_report($1, 'awaiting_code', NULL, NULL)", [id])).rejects.toMatchObject({ code: "22023" });
    await expect(as({ runner: r.id }, "SELECT machine_login_report($1, 'done', $2, NULL)", [id, Buffer.from("x")])).rejects.toMatchObject({ code: "22023" });
    // A session of another account sees and moves nothing, whoever it claims to be.
    const other = await seedF2(h.admin);
    const c = await h.appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.account_id', $1, true)", [other.accountId]);
      await c.query("SELECT set_config('app.runner_id', $1, true)", [r.id]);
      await expect(c.query("SELECT machine_login_code_take($1)", [id])).resolves.toMatchObject({ rows: [{ machine_login_code_take: null }] });
      await expect(c.query("SELECT machine_login_report($1, 'failed', NULL, NULL)", [id])).rejects.toMatchObject({ code: "P0002" });
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect((await reqRow(id)).status).toBe("code_ready");
    // The definers are not executable by everyone.
    const pub = await h.admin.query("SELECT has_function_privilege('public', 'machine_login_code_take(uuid)', 'EXECUTE') AS a, has_function_privilege('public', 'machine_login_report(uuid, text, bytea, text)', 'EXECUTE') AS b, has_function_privilege('public', 'machine_login_auth_url(uuid)', 'EXECUTE') AS c");
    expect(pub.rows[0]).toEqual({ a: false, b: false, c: false });
    const owners = await h.admin.query("SELECT proname, pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname IN ('machine_login_report', 'machine_login_code_take', 'machine_login_auth_url') ORDER BY proname");
    expect(owners.rows).toEqual([{ proname: "machine_login_auth_url", owner: "machine_ops", prosecdef: true }, { proname: "machine_login_code_take", owner: "machine_ops", prosecdef: true }, { proname: "machine_login_report", owner: "machine_ops", prosecdef: true }]);
  });

  it("a command row is the person's request and nothing else: a runner session cannot issue one, a member cannot, and a command cannot name another runner's request", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const r2 = await runner(f);
    const id = requestIdOf(await start(f, f.o1, r));
    const insert = async (userId: string | null, runnerSession: string | null, runnerId: string, kind: string, requestId: string | null) => {
      const c = await h.appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true)", [f.accountId]);
        if (userId) await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        if (runnerSession) await c.query("SELECT set_config('app.runner_id', $1, true)", [runnerSession]);
        return await c.query("INSERT INTO machine_commands (account_id, runner_id, kind, request_id, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '300 seconds')", [f.accountId, runnerId, kind, requestId, userId ?? f.o1]);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    await expect(insert(f.o1, r.id, r.id, "claude_logout", null)).rejects.toMatchObject({ code: "42501" });
    await expect(insert(f.m1, null, r.id, "claude_logout", null)).rejects.toMatchObject({ code: "42501" });
    await expect(insert(f.o1, null, r2.id, "claude_login_code", id)).rejects.toMatchObject({ code: "42501" });
    await expect(insert(f.o1, null, r.id, "claude_logout", id)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(f.o1, null, r.id, "claude_login_code", null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(f.o1, null, r.id, "gh_login_start", id)).rejects.toMatchObject({ code: "23514" });
    expect((await insert(f.o1, null, r.id, "claude_login_code", id)).rowCount).toBe(1);
  });
});
