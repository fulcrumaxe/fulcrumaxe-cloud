import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { createHetznerClient, createHetznerCredentialProbe, createHetznerProvider } from '../../hetzner/src/index.js';
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from '../../hetzner/test/helpers/strictHetzner.js';
import {
  MachineOpsError,
  connectHetznerCredential,
  machineKekSource,
  removeHetznerCredential,
  withHetznerToken,
  withManagedServer,
  type MachineOpsCtx,
} from '../src/index.js';
import { ForbiddenError } from '../src/errors.js';
import { open } from '../src/crypto.js';
import { buildAad } from '../src/types.js';
import { seedAccountWithMember, type SeededTenant } from './helpers/seed.js';

/** A generated test token: 64 letters and digits, never a real one. */
const newToken = (): string => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(64, 'x').slice(0, 64);
const kekEnv = () => ({ FX_MACHINE_KEK_V1: randomBytes(32).toString('base64') });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('D#845 MC-2: the sealed Hetzner token and its reader [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let fake: StrictHetzner;
  let world: FakeWorld;
  let kek = machineKekSource(kekEnv());
  const prevEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    process.env.NODE_ENV = prevEnv;
    admin.release();
    await adminPool.end();
    await appPool.end();
  });
  let token: string;
  beforeEach(async () => {
    token = newToken();
    world = newWorld([token]);
    fake = await startStrictHetzner(world);
    kek = machineKekSource(kekEnv());
  });
  afterEach(async () => {
    await fake.close();
    vi.restoreAllMocks();
  });

  const probe = () => createHetznerCredentialProbe({ maxRetries: 0, timeoutMs: 2000, sleep: async () => undefined, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
  const ctxOf = (t: SeededTenant, pool: Pool = appPool, k = kek): MachineOpsCtx & { probe: ReturnType<typeof probe> } => ({ pool, principal: t, kek: k, probe: probe() });
  const writes = () => world.requests.filter((r) => r.method !== 'GET').length;
  const unsealRows = async (t: SeededTenant) => (await admin.query<{ payload: Record<string, string> }>(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'server.unsealed' ORDER BY created_at`, [t.accountId])).rows.map((r) => r.payload);
  const credRow = async (t: SeededTenant) => (await admin.query(`SELECT * FROM machine_provider_credentials WHERE account_id = $1`, [t.accountId])).rows;
  const connected = async (role: 'owner' | 'admin' = 'owner'): Promise<{ t: SeededTenant; id: string }> => {
    const t = await seedAccountWithMember(admin, role);
    await connectHetznerCredential(ctxOf(t), { token });
    return { t, id: (await credRow(t))[0].id as string };
  };
  /** A managed server: needs a credential and a provisioning token row (the machine tables' own foreign keys). */
  const managedServer = async (t: SeededTenant, credentialId: string, providerId: string, status = 'ready'): Promise<string> => {
    const tok = (await admin.query(`INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, $3, 'subscription', now() + interval '1 hour') RETURNING id`, [t.accountId, t.userId, sha(randomUUID())])).rows[0].id as string;
    const gone = status === 'deleted';
    return (await admin.query(
      `INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, provider_server_id, status, deleted_at, deleted_by)
       VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [t.accountId, credentialId, tok, t.userId, providerId, status, gone ? new Date() : null, gone ? t.userId : null],
    )).rows[0].id as string;
  };

  it('POST: checks read and write, counts servers without our label, seals the token under account:row:hetzner_token, keeps a four-character hint, and audits ids only', async () => {
    const t = await seedAccountWithMember(admin, 'owner');
    const hz = createHetznerClient({ token, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
    await hz.createServer({ name: 'ours', serverType: 'cx22', location: 'fsn1', image: 'ubuntu-24.04', idempotencyKey: 'k1', labels: { 'fx-managed': '1' } });
    await hz.createServer({ name: 'theirs', serverType: 'cx22', location: 'fsn1', image: 'ubuntu-24.04', idempotencyKey: 'k2' });
    const view = await connectHetznerCredential(ctxOf(t), { token });
    expect(view).toMatchObject({ status: 'ok', token_hint: token.slice(-4), unlabelled_server_count: 1 });
    expect(Object.keys(view).sort()).toEqual(['created_at', 'id', 'status', 'token_hint', 'unlabelled_server_count']);
    expect(world.sshKeys).toEqual([]); // the probe key was made and deleted
    const [row] = await credRow(t);
    expect(open({ kek: kek.keyFor(1), aad: buildAad(t.accountId, view.id, 'hetzner_token') }, { ciphertext: row.ciphertext, nonce: row.nonce, wrappedDek: row.wrapped_dek })).toBe(token);
    expect(() => open({ kek: kek.keyFor(1), aad: buildAad(t.accountId, view.id, 'model_key') }, { ciphertext: row.ciphertext, nonce: row.nonce, wrappedDek: row.wrapped_dek })).toThrow();
    const audit = await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'machine_credential.added'`, [t.accountId]);
    expect(audit.rows).toEqual([{ payload: { credential_id: view.id, provider: 'hetzner_cloud' } }]);
  });

  it('the token is in no response, error, log line, table or audit row, through every outcome', async () => {
    const seen: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void seen.push(a.map(String).join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (seen.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (seen.push(String(c)), true));
    const outcomes: unknown[] = [];
    const t = await seedAccountWithMember(admin, 'owner');
    world.tokens.delete(token);
    outcomes.push(await connectHetznerCredential(ctxOf(t), { token }).catch((e: unknown) => e)); // 401
    world.tokens.add(token);
    world.readOnlyTokens = new Set([token]);
    outcomes.push(await connectHetznerCredential(ctxOf(t), { token }).catch((e: unknown) => e)); // read-only
    world.readOnlyTokens = undefined;
    world.failNext.push({ drop: true });
    outcomes.push(await connectHetznerCredential(ctxOf(t), { token }).catch((e: unknown) => e)); // unreachable
    outcomes.push(await connectHetznerCredential(ctxOf(t), { token: token.slice(0, 20) }).catch((e: unknown) => e));
    outcomes.push(await connectHetznerCredential(ctxOf(t), { token }));
    outcomes.push(await connectHetznerCredential(ctxOf(t), { token }).catch((e: unknown) => e)); // already connected
    outcomes.push(await withHetznerToken(ctxOf(t), async () => 'done'));
    outcomes.push(await withHetznerToken({ ...ctxOf(t), kek: machineKekSource({}) }, async () => 'x').catch((e: unknown) => e));
    await removeHetznerCredential(ctxOf(t));
    const text = JSON.stringify(outcomes, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)) + seen.join('\n');
    expect(text).not.toContain(token);
    expect(outcomes.filter((o) => o instanceof MachineOpsError).map((o) => (o as MachineOpsError).code)).toEqual(['token_invalid', 'token_read_only', 'provider_unreachable', 'invalid_token_format', 'already_connected', 'machine_kek_unset']);
    const { rows: tables } = await admin.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    for (const { table_name } of tables) {
      const { rows } = await admin.query(`SELECT 1 FROM "${table_name}" r WHERE r::text LIKE $1 LIMIT 1`, [`%${token}%`]);
      expect(rows, table_name).toEqual([]);
    }
  });

  it('a refused, read-only or unproven token saves nothing; a member, a second connect and a missing machine key never reach Hetzner', async () => {
    const t = await seedAccountWithMember(admin, 'owner');
    world.tokens.clear();
    await expect(connectHetznerCredential(ctxOf(t), { token })).rejects.toMatchObject({ code: 'token_invalid' });
    expect(writes()).toBe(0);
    world.tokens.add(token);
    world.readOnlyTokens = new Set([token]);
    await expect(connectHetznerCredential(ctxOf(t), { token })).rejects.toMatchObject({ code: 'token_read_only' });
    expect(await credRow(t)).toEqual([]);
    world.readOnlyTokens = undefined;
    const before = world.requests.length;
    const member = await seedAccountWithMember(admin, 'member');
    await expect(connectHetznerCredential(ctxOf(member), { token })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(connectHetznerCredential(ctxOf(t, appPool, machineKekSource({})), { token })).rejects.toMatchObject({ code: 'machine_kek_unset' });
    await expect(connectHetznerCredential(ctxOf(t, appPool, machineKekSource({ FX_MACHINE_KEK_V1: 'short' })), { token })).rejects.toMatchObject({ code: 'machine_kek_unset' });
    expect(world.requests.length).toBe(before);
    await connectHetznerCredential(ctxOf(t), { token });
    const after = world.requests.length;
    await expect(connectHetznerCredential(ctxOf(t), { token })).rejects.toMatchObject({ code: 'already_connected' });
    expect(world.requests.length).toBe(after);
    await expect(withHetznerToken(ctxOf(member), async () => 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('DELETE: the sealed columns become NULL, one audit row is written, the servers stay, and the reader then says there is no token', async () => {
    const { t, id } = await connected();
    const server = await managedServer(t, id, '4242');
    await removeHetznerCredential(ctxOf(t));
    expect(await credRow(t)).toMatchObject([{ ciphertext: null, nonce: null, wrapped_dek: null, removed_by: t.userId }]);
    expect((await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'machine_credential.removed'`, [t.accountId])).rows).toEqual([{ payload: { credential_id: id, provider: 'hetzner_cloud' } }]);
    expect((await admin.query(`SELECT status, provider_server_id FROM managed_servers WHERE id = $1`, [server])).rows).toEqual([{ status: 'ready', provider_server_id: '4242' }]);
    await expect(withHetznerToken(ctxOf(t), async () => 1)).rejects.toMatchObject({ code: 'not_connected', message: "can't reach Hetzner: no token" });
    await expect(withManagedServer(ctxOf(t), '4242', async () => 1)).rejects.toMatchObject({ code: 'not_connected' });
    await expect(removeHetznerCredential(ctxOf(t))).rejects.toMatchObject({ code: 'not_connected' });
    await connectHetznerCredential(ctxOf(t), { token }); // a new token can be added after a removal
  });

  it('unseal: exactly one server.unsealed row, written by the reader in the same transaction, with ids and enums only', async () => {
    const { t, id } = await connected();
    expect(await unsealRows(t)).toEqual([]);
    expect(await withHetznerToken(ctxOf(t), async (opened) => opened)).toBe(token);
    const rows = await unsealRows(t);
    expect(rows).toEqual([{ credential_id: id, purpose: 'hetzner_token' }]);
    for (const v of Object.values(rows[0]!)) expect(v).toMatch(/^([0-9a-f-]{36}|hetzner_token)$/);
    // the audit row and the sealed read are one transaction: a failure after the write (a seal that does not open) leaves no row behind
    await admin.query(`UPDATE machine_provider_credentials SET ciphertext = '\\x00'::bytea WHERE id = $1`, [id]);
    await expect(withHetznerToken(ctxOf(t), async () => 1)).rejects.toMatchObject({ code: 'unseal_failed' });
    expect(await unsealRows(t)).toHaveLength(1);
  });

  it('fails closed on every decrypt problem: tampered, moved to another account, wrong key, wrong purpose. The callback never runs and no unseal row is left', async () => {
    const { t, id } = await connected();
    const other = await connected();
    const call = vi.fn(async () => 'ran');
    const sealed = (await credRow(t))[0];
    const flip = (b: Buffer) => Buffer.concat([Buffer.from([b[0]! ^ 1]), b.subarray(1)]);
    for (const [col, v] of [['ciphertext', flip(sealed.ciphertext)], ['wrapped_dek', flip(sealed.wrapped_dek)], ['nonce', flip(sealed.nonce)]] as const) {
      await admin.query(`UPDATE machine_provider_credentials SET ${col} = $2 WHERE id = $1`, [id, v]);
      await expect(withHetznerToken(ctxOf(t), call), col).rejects.toMatchObject({ code: 'unseal_failed' });
      await admin.query(`UPDATE machine_provider_credentials SET ${col} = $2 WHERE id = $1`, [id, sealed[col]]);
    }
    // another account's seal copied onto this row (same KEK, different AAD)
    const foreign = (await credRow(other.t))[0];
    await admin.query(`UPDATE machine_provider_credentials SET ciphertext = $2, nonce = $3, wrapped_dek = $4 WHERE id = $1`, [id, foreign.ciphertext, foreign.nonce, foreign.wrapped_dek]);
    await expect(withHetznerToken(ctxOf(t), call)).rejects.toMatchObject({ code: 'unseal_failed' });
    await admin.query(`UPDATE machine_provider_credentials SET ciphertext = $2, nonce = $3, wrapped_dek = $4 WHERE id = $1`, [id, sealed.ciphertext, sealed.nonce, sealed.wrapped_dek]);
    await expect(withHetznerToken(ctxOf(t, appPool, machineKekSource(kekEnv())), call)).rejects.toMatchObject({ code: 'unseal_failed' }); // wrong key
    await admin.query(`UPDATE machine_provider_credentials SET kek_version = 2 WHERE id = $1`, [id]);
    await expect(withHetznerToken(ctxOf(t), call)).rejects.toMatchObject({ code: 'machine_kek_unset' }); // a version this key source does not hold
    await admin.query(`UPDATE machine_provider_credentials SET kek_version = 1 WHERE id = $1`, [id]);
    expect(call).not.toHaveBeenCalled();
    expect(await unsealRows(t)).toEqual([]);
    expect(await withHetznerToken(ctxOf(t), call)).toBe('ran'); // restored: opens again
  });

  it('a Hetzner action on a server id outside the account\'s managed_servers is refused before the seal is read and before any Hetzner call', async () => {
    const { t, id } = await connected();
    const other = await connected();
    await managedServer(other.t, other.id, '777');
    await managedServer(t, id, '888', 'deleted');
    const mine = await managedServer(t, id, '999');
    const before = world.requests.length;
    const call = vi.fn(async (opened: string) => createHetznerClient({ token: opened, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } }).listServers());
    for (const pid of ['123', '777', '888', 'abc', '', '1; DROP TABLE x']) await expect(withManagedServer(ctxOf(t), pid, call), pid).rejects.toMatchObject({ code: 'server_not_managed' });
    // read through the RLS-bypassing pool: only the explicit account predicate keeps account B's server out of account A's reach
    await expect(withManagedServer(ctxOf(t, adminPool), '777', call)).rejects.toMatchObject({ code: 'server_not_managed' });
    expect(call).not.toHaveBeenCalled();
    expect(world.requests.length).toBe(before);
    expect(await unsealRows(t)).toEqual([]);
    await withManagedServer(ctxOf(t, adminPool), '999', call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(await unsealRows(t)).toEqual([{ credential_id: id, purpose: 'hetzner_token', server_id: mine }]);
    expect(await unsealRows(other.t)).toEqual([]);
  });

  it('the reader reads the session account only: through the RLS-bypassing pool, a foreign account\'s token is still not found', async () => {
    const a = await connected();
    const b = await seedAccountWithMember(admin, 'owner');
    await expect(withHetznerToken(ctxOf(b, adminPool), async () => 1)).rejects.toMatchObject({ code: 'not_connected' });
    await expect(removeHetznerCredential(ctxOf(b, adminPool))).rejects.toMatchObject({ code: 'not_connected' });
    expect(await credRow(a.t)).toHaveLength(1);
    expect((await credRow(a.t))[0].removed_at).toBeNull();
    expect(await unsealRows(b)).toEqual([]);
    // a second account connects while the first holds a token: the "already connected" check reads its own account only
    const c = await seedAccountWithMember(admin, 'owner');
    await expect(connectHetznerCredential(ctxOf(c, adminPool), { token })).resolves.toMatchObject({ status: 'ok' });
    expect((await credRow(a.t))[0].removed_at).toBeNull();
  });

  it('a later 401 marks the credential invalid at once; a 403 does not; an invalid credential is not opened again', async () => {
    const { t, id } = await connected();
    const client = (opened: string) => createHetznerClient({ token: opened, maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
    world.failNext.push({ status: 403, code: 'forbidden' });
    await expect(withHetznerToken(ctxOf(t), (opened) => client(opened).listServers())).rejects.toMatchObject({ code: 'forbidden' });
    expect((await credRow(t))[0].status).toBe('ok');
    // through the provider seam a 403 is also `unauthorized`; only the 401 status marks the credential
    world.failNext.push({ status: 403, code: 'forbidden' });
    await expect(withHetznerToken(ctxOf(t), (opened) => createHetznerProvider(client(opened)).listByLabel('a=b'))).rejects.toMatchObject({ code: 'unauthorized', extra: { status: 403 } });
    expect((await credRow(t))[0].status).toBe('ok');
    world.tokens.delete(token); // Hetzner now refuses it
    await expect(withHetznerToken(ctxOf(t), (opened) => client(opened).listServers())).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await credRow(t))[0]).toMatchObject({ id, status: 'invalid' });
    const rows = (await unsealRows(t)).length;
    await expect(withHetznerToken(ctxOf(t), async () => 1)).rejects.toMatchObject({ code: 'credential_invalid' });
    expect(await unsealRows(t)).toHaveLength(rows);
  });
});
