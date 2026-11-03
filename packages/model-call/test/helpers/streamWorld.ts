import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { buildAad, connect, connectionAad, seal } from '@fx/model-connection';
import { fakeKekSource } from '../../../model-connection/test/helpers/fakeKek.js';
import { seedAccountWithMember } from '../../../model-connection/test/helpers/seed.js';
import { startStrictProviders, type StrictProviders } from '../../../model-connection/test/helpers/strictProviders.js';
import { chatTurnChunks } from '../../../model-connection/test/helpers/gatewayChatFake.js';
import { turnEvents } from '../../../model-connection/test/helpers/anthropicMessagesFake.js';
import type { ModelCallCtx } from '../../src/index.js';

export { turnEvents, chatTurnChunks };
/** Fake keys are built from parts at run time: no token-shaped literal in source (gitleaks). */
export const fakeKey = (kind: 'api03' | 'oat01', tag: string) => ['sk', 'ant', kind, tag, '0123456789'].join('-');

export const baseParams = {
  role: 'assistant',
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [{ name: 'read_item', description: 'Read a work item', input_schema: { type: 'object', properties: { id: { type: 'string' } } } }],
  maxOutputTokens: 1024,
  timeoutMs: 5000,
};

/** The strict TLS providers plus a migrated database: tenants hold a sealed Anthropic key and call through the real TLS transport. */
export async function startWorld() {
  const adminPool = createPool(process.env.DATABASE_URL!);
  const admin: PoolClient = await adminPool.connect();
  const pool: Pool = createPool(process.env.DATABASE_URL_APP_USER!);
  const opsPool: Pool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  const providers: StrictProviders = await startStrictProviders();
  providers.anthropic.messages.enabled = true;
  providers.ai_gateway.chat.enabled = true;
  const kek = fakeKekSource();

  /** connect() refuses 'anthropic' until S11, so that row is a gateway row re-sealed and retagged (see completeJson.test.ts). */
  async function tenant(key: string, provider: 'anthropic' | 'ai_gateway' = 'anthropic') {
    const t = await seedAccountWithMember(admin, 'owner');
    await connect({ pool, platformOpsPool: opsPool, principal: t, httpClient: { validate: async () => ({ kind: 'ok' as const }) }, kek }, { provider: 'ai_gateway', key });
    if (provider === 'anthropic') {
      const { id } = (await admin.query(`SELECT id FROM model_connections WHERE account_id = $1`, [t.accountId])).rows[0];
      const old = seal({ kek: kek.keyFor(1), aad: buildAad(t.accountId, id) }, key);
      await admin.query(`UPDATE model_connections SET provider = 'anthropic', credential_kind = 'anthropic', aad_version = 1, key_ciphertext = $2, key_nonce = $3, wrapped_dek = $4 WHERE account_id = $1`, [t.accountId, old.ciphertext, old.nonce, old.wrappedDek]);
      providers.anthropic.knownKeys.add(key);
    }
    if (provider === 'ai_gateway') providers.ai_gateway.knownKeys.add(key);
    const ctx: ModelCallCtx = { pool, platformOpsPool: opsPool, principal: t, kek, fetchImpl: providers.transport };
    return { ...t, ctx };
  }
  /** A real `openai` row of the given credential kind (migration 0800): sealed under the v2 AAD that binds the kind, so the key opens and the provider shape is what decides. */
  async function tenantOpenAi(key: string, kind: 'openai_api_key' | 'codex_access_token' | 'chatgpt_oauth') {
    const t = await seedAccountWithMember(admin, 'owner');
    await connect({ pool, platformOpsPool: opsPool, principal: t, httpClient: { validate: async () => ({ kind: 'ok' as const }) }, kek }, { provider: 'ai_gateway', key });
    const { id } = (await admin.query(`SELECT id FROM model_connections WHERE account_id = $1`, [t.accountId])).rows[0];
    const sealed = seal({ kek: kek.keyFor(1), aad: connectionAad({ accountId: t.accountId, connectionId: id, credentialKind: kind, aadVersion: 2 }) }, key);
    await admin.query(`UPDATE model_connections SET provider = 'openai', credential_kind = $5, aad_version = 2, key_ciphertext = $2, key_nonce = $3, wrapped_dek = $4 WHERE account_id = $1`, [t.accountId, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, kind]);
    const ctx: ModelCallCtx = { pool, platformOpsPool: opsPool, principal: t, kek, fetchImpl: providers.transport };
    return { ...t, ctx };
  }
  const connectionStatus = async (accountId: string) => (await admin.query(`SELECT status FROM model_connections WHERE account_id = $1`, [accountId])).rows[0].status as string;

  return {
    providers,
    tenant,
    tenantOpenAi,
    connectionStatus,
    messages: providers.anthropic.messages,
    chat: providers.ai_gateway.chat,
    /** Between tests: forget scripted replies and recorded calls on every provider (the messages route stays enabled). */
    reset: () => {
      const m = providers.anthropic.messages;
      m.replies.length = 0;
      m.calls.length = 0;
      m.unscripted = 0;
      m.chunkBytes = 0;
      const c = providers.ai_gateway.chat;
      c.replies.length = 0;
      c.calls.length = 0;
      c.unscripted = 0;
      c.chunkBytes = 0;
      for (const p of [providers.ai_gateway, providers.anthropic, providers.openai]) {
        p.seen.length = 0;
        p.refused.length = 0;
      }
    },
    stop: async () => {
      admin.release();
      await Promise.all([adminPool.end(), pool.end(), opsPool.end(), providers.close()]);
    },
  };
}
