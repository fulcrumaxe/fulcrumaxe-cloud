import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { connect } from '../src/connect.js';
import { admitCredential, type AdmitCredentialInput } from '../src/credentialPolicy.js';
import { open, seal } from '../src/crypto.js';
import { DecryptionFailedError, InvalidModelKeyError } from '../src/errors.js';
import { recordAcknowledgement, setKindEnabled } from '../src/index.js';
import { healthCheck, test as testConnection } from '../src/validate.js';
import { buildAad, connectionAad, type CredentialKind } from '../src/types.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

/**
 * D#221 MC1 against the real schema: the new columns, the checks that keep them honest, kind-bound sealing, the
 * connect paths and their refusals, and admission of a credential (the matrix, then the kill switch and the notice for
 * the plan-based kinds). Pure parts are in credentialPolicy.test.ts.
 */
describe('MC1: connection kinds', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let ctx: ReturnType<typeof ctxFactory>;
  const kek = fakeKekSource();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    ctx = ctxFactory(appUserPool, platformOpsPool);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  const ok = () => fakeHttpClient({ kind: 'ok' });
  async function row(accountId: string) {
    const { rows } = await admin.query(
      `SELECT id, provider, credential_kind, backend, aad_version, status, key_ciphertext, key_nonce, wrapped_dek, kek_version
         FROM model_connections WHERE account_id = $1`,
      [accountId],
    );
    return rows[0];
  }
  /** The key as the stored row opens (through test(), which opens it to prove it): what the provider was handed. */
  async function storedKey(t: { accountId: string; userId: string }): Promise<{ provider: string; key: string }> {
    const client = ok();
    await testConnection(ctx(t, client, kek));
    return { provider: client.calls[0]!.provider, key: client.calls[0]!.plaintextKey };
  }
  async function refusal(promise: Promise<unknown>): Promise<string> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidModelKeyError);
    return (err as InvalidModelKeyError).providerCode;
  }

  describe('what connect() stores', () => {
    it('a gateway key: kind ai_gateway, claude-code, sealed under AAD version 2 with the kind in it', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const status = await connect(ctx(t, ok(), kek), { provider: 'ai_gateway', key: 'vck_gateway_key_1' });
      expect(status.provider).toBe('ai_gateway');
      const r = await row(t.accountId);
      expect([r.provider, r.credential_kind, r.backend, r.aad_version, r.status]).toEqual(['ai_gateway', 'ai_gateway', 'claude-code', 2, 'ok']);
      const aad = connectionAad({ accountId: t.accountId, connectionId: r.id, credentialKind: 'ai_gateway', aadVersion: 2 });
      const sealed = { ciphertext: r.key_ciphertext, nonce: r.key_nonce, wrappedDek: r.wrapped_dek };
      expect(open({ kek: kek.keyFor(r.kek_version), aad }, sealed)).toBe('vck_gateway_key_1');
      // The original, kind-less AAD no longer opens a new row: a new row is not version 1.
      expect(() => open({ kek: kek.keyFor(r.kek_version), aad: buildAad(t.accountId, r.id) }, sealed)).toThrow(DecryptionFailedError);
    });

    it('an OpenAI key: provider openai, kind openai_api_key, backend codex by default, validated against the openai provider', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const client = ok();
      const status = await connect(ctx(t, client, kek), { provider: 'openai', key: 'sk-proj-openai-1' });
      expect(status).toMatchObject({ provider: 'openai', status: 'ok' });
      expect(client.calls).toEqual([{ provider: 'openai', plaintextKey: 'sk-proj-openai-1' }]);
      const r = await row(t.accountId);
      expect([r.provider, r.credential_kind, r.backend, r.aad_version]).toEqual(['openai', 'openai_api_key', 'codex', 2]);
      const opened = await storedKey(t);
      expect(opened).toEqual({ provider: 'openai', key: 'sk-proj-openai-1' });
    });

    it('an OpenAI key may name opencode; claude-code is refused for it with nothing stored and no network call', async () => {
      const a = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(a, ok(), kek), { provider: 'openai', key: 'sk-proj-openai-2', backend: 'opencode' });
      expect((await row(a.accountId)).backend).toBe('opencode');

      const b = await seedAccountWithMember(admin, 'owner');
      const client = ok();
      expect(await refusal(connect(ctx(b, client, kek), { provider: 'openai', key: 'sk-proj-openai-3', backend: 'claude-code' }))).toBe('credential_not_allowed');
      expect(client.calls).toHaveLength(0);
      expect(await row(b.accountId)).toBeUndefined();
    });

    it('refuses an unknown backend and a kind that does not belong to the provider, before any network call', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const client = ok();
      const c = ctx(t, client, kek);
      expect(await refusal(connect(c, { provider: 'openai', key: 'sk-x', backend: 'cursor' as never }))).toBe('unknown_backend');
      expect(await refusal(connect(c, { provider: 'ai_gateway', key: 'vck_x', credentialKind: 'openai_api_key' }))).toBe('invalid_credential_kind');
      expect(await refusal(connect(c, { provider: 'openai', key: 'sk-x', credentialKind: 'ai_gateway' }))).toBe('invalid_credential_kind');
      expect(await refusal(connect(c, { provider: 'openai', key: 'sk-x', credentialKind: 'made_up' as never }))).toBe('invalid_credential_kind');
      expect(await refusal(connect(c, { provider: 'azure' as never, key: 'sk-x' }))).toBe('invalid_provider');
      expect(client.calls).toHaveLength(0);
      expect(await row(t.accountId)).toBeUndefined();
    });

    it('the plan-based kinds are defined but cannot be connected here: refused by name, nothing stored, no network call', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const client = ok();
      for (const credentialKind of ['codex_access_token', 'chatgpt_oauth'] as const) {
        // Not even with the kill switch on: the connect paths belong to later changes.
        await setKindEnabled(platformOpsPool, credentialKind, true, 'test');
        expect(await refusal(connect(ctx(t, client, kek), { provider: 'openai', key: 'tok_x', credentialKind }))).toBe('kind_not_connectable');
      }
      expect(client.calls).toHaveLength(0);
      expect(await row(t.accountId)).toBeUndefined();
      await admin.query(`UPDATE plan_kind_switches SET enabled = false, updated_by = 'test-reset'`);
    });

    it('replacing a key keeps the stored backend while the policy allows it, and falls back to the default when it does not', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(t, ok(), kek), { provider: 'openai', key: 'sk-proj-a', backend: 'opencode' });
      await connect(ctx(t, ok(), kek), { provider: 'openai', key: 'sk-proj-b' });
      expect((await row(t.accountId)).backend).toBe('opencode');
      // opencode also takes the gateway key, so it stays.
      await connect(ctx(t, ok(), kek), { provider: 'ai_gateway', key: 'vck_c' });
      expect((await row(t.accountId)).backend).toBe('opencode');

      const u = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(u, ok(), kek), { provider: 'ai_gateway', key: 'vck_d' });
      expect((await row(u.accountId)).backend).toBe('claude-code');
      // claude-code does not take an OpenAI key, so the OpenAI default applies.
      await connect(ctx(u, ok(), kek), { provider: 'openai', key: 'sk-proj-e' });
      const r = await row(u.accountId);
      expect([r.provider, r.credential_kind, r.backend, r.aad_version]).toEqual(['openai', 'openai_api_key', 'codex', 2]);
      // And back again: the undo path for a mistaken provider is another connect, which re-seals under the new kind.
      // codex takes the gateway key as well, so the stored backend stays; naming claude-code moves it back.
      await connect(ctx(u, ok(), kek), { provider: 'ai_gateway', key: 'vck_f' });
      const back = await row(u.accountId);
      expect([back.provider, back.credential_kind, back.backend, back.aad_version]).toEqual(['ai_gateway', 'ai_gateway', 'codex', 2]);
      await connect(ctx(u, ok(), kek), { provider: 'ai_gateway', key: 'vck_g', backend: 'claude-code' });
      expect((await row(u.accountId)).backend).toBe('claude-code');
      expect(await storedKey(u)).toEqual({ provider: 'ai_gateway', key: 'vck_g' });
    });

    it('the audit row keeps its shape (provider and fingerprint) for an OpenAI key, and never holds the key', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(t, ok(), kek), { provider: 'openai', key: 'sk-proj-never-in-audit' });
      const { rows } = await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1`, [t.accountId]);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0].payload).sort()).toEqual(['fingerprint', 'provider']);
      expect(rows[0].payload.provider).toBe('openai');
      expect(JSON.stringify(rows[0].payload)).not.toContain('sk-proj-never-in-audit');
    });
  });

  describe('a sealed key cannot be moved into another kind (S2)', () => {
    it('retagging an OpenAI row as another OpenAI kind makes every reader fail closed', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(t, ok(), kek), { provider: 'openai', key: 'sk-proj-swap' });
      // The CHECK allows this (same provider); only the AAD stands in the way.
      await admin.query(`UPDATE model_connections SET credential_kind = 'codex_access_token' WHERE account_id = $1`, [t.accountId]);
      await expect(storedKey(t)).rejects.toBeInstanceOf(DecryptionFailedError);
      await expect(testConnection(ctx(t, ok(), kek))).rejects.toBeInstanceOf(DecryptionFailedError);
      await expect(healthCheck({ pool: appUserPool, platformOpsPool, httpClient: ok(), kek }, t.accountId)).rejects.toBeInstanceOf(DecryptionFailedError);
      await admin.query(`UPDATE model_connections SET credential_kind = 'openai_api_key' WHERE account_id = $1`, [t.accountId]);
      expect(await storedKey(t)).toEqual({ provider: 'openai', key: 'sk-proj-swap' });
    });

    it('retagging a gateway row as Anthropic, or pushing a new row back to version 1, fails closed', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(t, ok(), kek), { provider: 'ai_gateway', key: 'vck_swap' });
      await admin.query(`UPDATE model_connections SET provider = 'anthropic', credential_kind = 'anthropic' WHERE account_id = $1`, [t.accountId]);
      await expect(storedKey(t)).rejects.toBeInstanceOf(DecryptionFailedError);
      await admin.query(`UPDATE model_connections SET provider = 'ai_gateway', credential_kind = 'ai_gateway' WHERE account_id = $1`, [t.accountId]);
      await admin.query(`UPDATE model_connections SET aad_version = 1 WHERE account_id = $1`, [t.accountId]);
      await expect(storedKey(t)).rejects.toBeInstanceOf(DecryptionFailedError);
    });

    it('a row sealed before the kind existed (version 1, defaults filled in) still opens, and is replaced by a version-2 seal on the next connect', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      const id = randomUUID();
      const sealed = seal({ kek: kek.keyFor(1), aad: buildAad(t.accountId, id) }, 'vck_legacy_row');
      await admin.query(
        `INSERT INTO model_connections (id, account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
         VALUES ($1, $2, 'ai_gateway', $3, $4, $5, 1, 'abcd')`,
        [id, t.accountId, sealed.ciphertext, sealed.nonce, sealed.wrappedDek],
      );
      const r = await row(t.accountId);
      expect([r.credential_kind, r.aad_version, r.backend]).toEqual(['ai_gateway', 1, 'claude-code']);
      expect(await storedKey(t)).toEqual({ provider: 'ai_gateway', key: 'vck_legacy_row' });
      await connect(ctx(t, ok(), kek), { provider: 'ai_gateway', key: ['vck_', 'legacy_row_2'].join('') }); // gitleaks:allow
      expect((await row(t.accountId)).aad_version).toBe(2);
      expect(await storedKey(t)).toEqual({ provider: 'ai_gateway', key: ['vck_', 'legacy_row_2'].join('') }); // gitleaks:allow
    });
  });

  describe('the schema keeps the columns honest', () => {
    const sealedBytes = seal({ kek: kek.keyFor(1), aad: Buffer.from('x') }, 'k');
    /** A raw INSERT as the superuser, naming only the columns the case is about. */
    async function insert(provider: string, extra: Record<string, unknown> = {}) {
      const accountId = (await seedAccountWithMember(admin, 'owner')).accountId;
      const cols = ['account_id', 'provider', 'key_ciphertext', 'key_nonce', 'wrapped_dek', 'kek_version', 'key_fingerprint', ...Object.keys(extra)];
      const values = [accountId, provider, sealedBytes.ciphertext, sealedBytes.nonce, sealedBytes.wrappedDek, 1, 'abcd', ...Object.values(extra)];
      return admin.query(
        `INSERT INTO model_connections (${cols.join(', ')}) VALUES (${values.map((_, i) => '$' + (i + 1)).join(', ')})
         RETURNING credential_kind, aad_version, backend`,
        values,
      );
    }

    it('fills the kind from the provider for the two original providers, and leaves an OpenAI row without a kind refused', async () => {
      expect((await insert('anthropic')).rows[0]).toEqual({ credential_kind: 'anthropic', aad_version: 1, backend: 'claude-code' });
      expect((await insert('ai_gateway')).rows[0]).toEqual({ credential_kind: 'ai_gateway', aad_version: 1, backend: 'claude-code' });
      await expect(insert('openai')).rejects.toMatchObject({ code: '23514', constraint: 'model_connections_credential_kind_present_check' });
    });

    it('refuses a kind its provider does not carry, an unknown provider, an OpenAI row at AAD version 1, and a bad backend name or version', async () => {
      await expect(insert('ai_gateway', { credential_kind: 'openai_api_key', aad_version: 2 })).rejects.toMatchObject({ constraint: 'model_connections_kind_provider_check' });
      await expect(insert('openai', { credential_kind: 'ai_gateway', aad_version: 2 })).rejects.toMatchObject({ constraint: 'model_connections_kind_provider_check' });
      await expect(insert('openai', { credential_kind: 'made_up', aad_version: 2 })).rejects.toMatchObject({ constraint: 'model_connections_kind_provider_check' });
      await expect(insert('azure', { credential_kind: 'ai_gateway' })).rejects.toMatchObject({ code: '23514' });
      for (const kind of ['openai_api_key', 'codex_access_token', 'chatgpt_oauth']) {
        await expect(insert('openai', { credential_kind: kind, aad_version: 1 })).rejects.toMatchObject({ constraint: 'model_connections_aad_version_kind_check' });
        expect((await insert('openai', { credential_kind: kind, aad_version: 2 })).rows[0]).toMatchObject({ credential_kind: kind, aad_version: 2 });
      }
      for (const [extra, constraint] of [
        [{ backend: 'Bad Name' }, 'model_connections_backend_name_check'],
        [{ backend: '' }, 'model_connections_backend_name_check'],
        [{ backend: '9codex' }, 'model_connections_backend_name_check'],
        [{ aad_version: 3 }, 'model_connections_aad_version_check'],
      ] as const) {
        await expect(insert('ai_gateway', extra)).rejects.toMatchObject({ constraint });
      }
    });

    it('a tenant retagging a validated row drops it back to unvalidated; changing only the backend does not', async () => {
      const t = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(t, ok(), kek), { provider: 'openai', key: 'sk-proj-guard' });
      expect((await row(t.accountId)).status).toBe('ok');
      await withTenant(appUserPool, t.accountId, t.userId, (c) => c.query(`UPDATE model_connections SET backend = 'opencode' WHERE account_id = $1`, [t.accountId]));
      expect([(await row(t.accountId)).status, (await row(t.accountId)).backend]).toEqual(['ok', 'opencode']);
      await withTenant(appUserPool, t.accountId, t.userId, (c) =>
        c.query(`UPDATE model_connections SET credential_kind = 'codex_access_token' WHERE account_id = $1`, [t.accountId]),
      );
      expect((await row(t.accountId)).status).toBe('unvalidated');
    });
  });

  describe('admitCredential: the matrix, then the kill switch and the notice for the plan-based kinds', () => {
    let principal: { accountId: string; userId: string };
    let connectionId: string;

    beforeEach(async () => {
      await admin.query(`UPDATE plan_kind_switches SET enabled = false, updated_by = 'test-reset'`);
      await admin.query('DELETE FROM plan_kind_switch_audit');
      principal = await seedAccountWithMember(admin, 'owner');
      connectionId = randomUUID();
    });

    const admit = (input: Omit<AdmitCredentialInput, 'connectionId'> & { connectionId?: string }, who = () => principal) =>
      withTenant(appUserPool, who().accountId, who().userId, (c) => admitCredential(c, { connectionId, ...input }));
    const ack = (kind: CredentialKind, id = connectionId, who = principal) =>
      recordAcknowledgement({ pool: appUserPool, principal: who }, { connectionId: id, kind });

    it('allows the kinds that need no notice with both switches off', async () => {
      for (const [backend, credentialKind] of [
        ['claude-code', 'ai_gateway'],
        ['claude-code', 'anthropic'],
        ['codex', 'ai_gateway'],
        ['codex', 'openai_api_key'],
        ['opencode', 'openai_api_key'],
      ] as const) {
        expect(await admit({ backend, credentialKind, placement: 'hosted' }), `${backend} / ${credentialKind}`).toEqual({ ok: true });
      }
    });

    for (const kind of ['codex_access_token', 'chatgpt_oauth'] as const) {
      it(`${kind}: refused with the switch off, then with no acknowledgement, then allowed, then refused again when the switch goes off`, async () => {
        const input = { backend: 'codex', credentialKind: kind, placement: 'hosted' } as const;
        // Switch off, even with the notice acknowledged: the switch is the platform's, the notice the customer's.
        await ack(kind);
        expect(await admit(input)).toEqual({ ok: false, reason: 'plan_kind_disabled' });
        await setKindEnabled(platformOpsPool, kind, true, 'ops:test');
        expect(await admit(input)).toEqual({ ok: true });
        // The undo path: flipping the switch off refuses the very next admission.
        await setKindEnabled(platformOpsPool, kind, false, 'ops:test');
        expect(await admit(input)).toEqual({ ok: false, reason: 'plan_kind_disabled' });
      });

      it(`${kind}: with the switch on, no acknowledgement, one for another connection, one for another kind and one from another account are all refused`, async () => {
        const input = { backend: 'codex', credentialKind: kind, placement: 'hosted' } as const;
        await setKindEnabled(platformOpsPool, kind, true, 'ops:test');
        expect(await admit(input)).toEqual({ ok: false, reason: 'notice_not_acknowledged' });

        await ack(kind, randomUUID());
        expect(await admit(input)).toEqual({ ok: false, reason: 'notice_not_acknowledged' });

        const other = kind === 'chatgpt_oauth' ? 'codex_access_token' : 'chatgpt_oauth';
        await ack(other);
        expect(await admit(input)).toEqual({ ok: false, reason: 'notice_not_acknowledged' });

        // A different account acknowledging this connection id does not count (the read is tenant-scoped).
        const stranger = await seedAccountWithMember(admin, 'owner');
        await ack(kind, connectionId, stranger);
        expect(await admit(input)).toEqual({ ok: false, reason: 'notice_not_acknowledged' });

        // (Notice versions: only 'v1' exists, and the table refuses any other, so a stale-version case cannot be
        // staged yet. admitCredential reads hasAcknowledgementWithClient, which matches the CURRENT version.)

        await ack(kind);
        expect(await admit(input)).toEqual({ ok: true });
      });
    }

    it('the matrix is checked first: switch on and notice acknowledged do not make a refused pairing allowed', async () => {
      for (const kind of ['codex_access_token', 'chatgpt_oauth'] as const) {
        await setKindEnabled(platformOpsPool, kind, true, 'ops:test');
        await ack(kind);
      }
      for (const [backend, credentialKind, placement] of [
        ['opencode', 'chatgpt_oauth', 'hosted'],
        ['opencode', 'codex_access_token', 'hosted'],
        ['claude-code', 'chatgpt_oauth', 'hosted'],
        ['codex', 'chatgpt_oauth', 'self_hosted'],
      ] as const) {
        expect(await admit({ backend, credentialKind, placement }), `${backend} / ${credentialKind} / ${placement}`).toEqual({
          ok: false,
          reason: 'credential_not_allowed',
        });
      }
    });

    it('refuses unknown input by name', async () => {
      expect(await admit({ backend: 'cursor', credentialKind: 'ai_gateway', placement: 'hosted' })).toEqual({ ok: false, reason: 'unknown_backend' });
      expect(await admit({ backend: 'codex', credentialKind: 'plan', placement: 'hosted' })).toEqual({ ok: false, reason: 'unknown_credential_kind' });
      expect(await admit({ backend: 'codex', credentialKind: 'ai_gateway', placement: 'moon' })).toEqual({ ok: false, reason: 'unknown_placement' });
      // A malformed connection id is a refusal too, not a database error.
      await setKindEnabled(platformOpsPool, 'chatgpt_oauth', true, 'ops:test');
      expect(await admit({ backend: 'codex', credentialKind: 'chatgpt_oauth', placement: 'hosted', connectionId: 'not-a-uuid' })).toEqual({
        ok: false,
        reason: 'notice_not_acknowledged',
      });
    });
  });
});
