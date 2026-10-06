import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { connect } from '@fx/model-connection';
import { fakeKekSource } from '../../model-connection/test/helpers/fakeKek.js';
import { seedAccountWithMember } from '../../model-connection/test/helpers/seed.js';
import { completeJson, ModelCallError, type ModelCallCtx } from '../src/index.js';
import { anthropicReply, FakeProvider, gatewayReply } from './helpers/fakeProvider.js';

const schema = z.object({ status: z.enum(['ok', 'thin']), follow_up: z.string().max(300).nullable() });
const params = { role: 'project-interviewer', system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], schema, maxOutputTokens: 1024, timeoutMs: 30000 };
const GOOD = JSON.stringify({ status: 'thin', follow_up: 'Who is it for?' });
const keyOf = (s: { headers: Record<string, unknown> }) => String(s.headers.authorization ?? s.headers['x-api-key']).replace('Bearer ', '');

describe('completeJson (fake provider only)', () => {
  let adminPool: Pool, admin: PoolClient, pool: Pool, opsPool: Pool, fake: FakeProvider;
  const kek = fakeKekSource();

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    pool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    fake = await new FakeProvider().start();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), pool.end(), opsPool.end(), fake.stop()]);
  });
  afterEach(() => {
    fake.seen = [];
    fake.requestedHosts = [];
    vi.unstubAllEnvs();
  });

  /** A tenant with a stored key. `provider` is set on the row directly: connect() refuses 'anthropic' until S11. */
  async function tenant(key: string, provider = 'ai_gateway', onCall?: () => void) {
    const t = await seedAccountWithMember(admin, 'owner');
    const httpClient = { validate: async () => ({ kind: 'ok' as const }) };
    await connect({ pool, platformOpsPool: opsPool, principal: t, httpClient, kek }, { provider: 'ai_gateway', key });
    if (provider !== 'ai_gateway') await admin.query(`UPDATE model_connections SET provider = $2 WHERE account_id = $1`, [t.accountId, provider]);
    const ctx: ModelCallCtx = { pool, platformOpsPool: opsPool, principal: t, kek, fetchImpl: fake.fetchImpl(onCall) };
    return { ...t, ctx };
  }
  const status = async (id: string) => (await admin.query(`SELECT status FROM model_connections WHERE account_id = $1`, [id])).rows[0].status;

  it('happy path: both providers, constant host, right auth header, parsed value and usage', async () => {
    const gw = await tenant('vck_gatewaykey_0123456789');
    fake.reply(gatewayReply(GOOD));
    expect(await completeJson(gw.ctx, params)).toEqual({ value: { status: 'thin', follow_up: 'Who is it for?' }, usage: { inputTokens: 5, outputTokens: 3 } });
    const an = await tenant('sk-ant-api03-anthropickey_0123456789', 'anthropic');
    fake.reply(anthropicReply('```json\n' + GOOD + '\n```'));
    expect((await completeJson(an.ctx, params)).usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(fake.requestedHosts).toEqual(['ai-gateway.vercel.sh', 'api.anthropic.com']);
    expect(fake.seen.map((s) => s.path)).toEqual(['/v1/chat/completions', '/v1/messages']);
    expect(fake.seen.map(keyOf)).toEqual(['vck_gatewaykey_0123456789', 'sk-ant-api03-anthropickey_0123456789']);
    expect(JSON.parse(fake.seen[1]!.body)).toMatchObject({ max_tokens: 1024, system: 'sys' });
    expect(fake.seen[1]!.body).not.toMatch(/tools|stream/);
  });

  it('invalid output (not JSON, wrong schema, wrong envelope) is "no follow-up", not an error, and is not retried', async () => {
    const gw = await tenant('vck_invalid_0123456789');
    for (const body of [gatewayReply('not json'), gatewayReply(JSON.stringify({ status: 'bogus', follow_up: null })), { unexpected: true }]) {
      fake.reply(body);
      expect((await completeJson(gw.ctx, params)).value).toBeNull();
    }
    expect(fake.seen).toHaveLength(3);
  });

  it('S2a: the account comes from ctx only -- each tenant sends its own key; a non-member principal gets NotFound', async () => {
    const [a, b] = [await tenant('vck_tenant_a_0123456789'), await tenant('vck_tenant_b_0123456789')];
    fake.reply(gatewayReply(GOOD));
    await completeJson(a.ctx, params);
    await completeJson(b.ctx, params);
    expect(fake.seen.map(keyOf)).toEqual(['vck_tenant_a_0123456789', 'vck_tenant_b_0123456789']);
    await expect(completeJson({ ...a.ctx, principal: { accountId: a.accountId, userId: b.userId } }, params)).rejects.toThrow(/no connection/);
    expect(fake.seen).toHaveLength(2);
  });

  it('S2b: two module instances across two tenants share no key state', async () => {
    const [a, b] = [await tenant('vck_double_a_0123456789'), await tenant('vck_double_b_0123456789')];
    fake.reply(gatewayReply(GOOD));
    vi.resetModules();
    const m1 = await import('../src/index.js');
    vi.resetModules();
    const m2 = await import('../src/index.js');
    expect(m1.completeJson).not.toBe(m2.completeJson);
    for (const [m, t] of [[m1, a], [m2, b], [m1, b], [m2, a]] as const) await m.completeJson(t.ctx, params);
    expect(fake.seen.map(keyOf)).toEqual(['vck_double_a_0123456789', 'vck_double_b_0123456789', 'vck_double_b_0123456789', 'vck_double_a_0123456789']);
  });

  it('S2c: a provider 400 that echoes the key yields a redacted, truncated error', async () => {
    const key = 'plain-key-with-no-known-shape-9876';
    const t = await tenant(key);
    for (const pad of [0, 480]) {
      // pad 480 puts the key across the 500-character cut: redaction must run before truncation.
      fake.reply({ error: 'x'.repeat(pad) + `bad key ${key} ` + 'y'.repeat(2000) }, 400);
      const err = (await completeJson(t.ctx, params).catch((e) => e)) as ModelCallError;
      expect(err).toBeInstanceOf(ModelCallError);
      const dump = `${err.message}${err.stack}${JSON.stringify(err)}`;
      expect(dump).not.toContain(key.slice(0, 8));
      expect(err.message.length).toBeLessThan(700);
      if (pad === 0) expect(err.message).toContain('[redacted]');
    }
  });

  it('S2e: a 302 to another origin fails and sends no second request', async () => {
    const other = await new FakeProvider().start();
    try {
      const t = await tenant('vck_redirect_0123456789');
      fake.handler = (_req, res) => res.writeHead(302, { location: `${other.origin}/steal` }).end();
      await expect(completeJson(t.ctx, params)).rejects.toMatchObject({ code: 'fetch_failed' });
      expect([fake.seen.length, other.seen.length]).toEqual([1, 0]);
    } finally {
      await other.stop();
    }
  });

  it('S2f: no checked-out connection during the provider call; a hung provider times out', async () => {
    let busy = -1;
    const t = await tenant('vck_timeout_0123456789', 'ai_gateway', () => (busy = pool.totalCount - pool.idleCount + (opsPool.totalCount - opsPool.idleCount)));
    fake.reply(gatewayReply(GOOD));
    await completeJson(t.ctx, params);
    expect(busy).toBe(0);
    fake.handler = () => undefined; // never answers
    const started = Date.now();
    await expect(completeJson(t.ctx, { ...params, timeoutMs: 150 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('S2g: a subscription (OAuth-token) credential is refused before any request', async () => {
    const t = await tenant('sk-ant-oat01-subscriptiontoken_0123456789');
    await expect(completeJson(t.ctx, params)).rejects.toMatchObject({ code: 'subscription_credential' });
    expect(fake.seen).toHaveLength(0);
  });

  it('S2h: FX_FORBID_MODEL_CALLS set + the real transport throws before touching the DB or the network', async () => {
    vi.stubEnv('FX_FORBID_MODEL_CALLS', '1');
    const t = await tenant('vck_forbid_0123456789');
    const spies = [vi.spyOn(pool, 'connect'), vi.spyOn(pool, 'query')];
    await expect(completeJson({ ...t.ctx, fetchImpl: undefined }, params)).rejects.toMatchObject({ code: 'forbidden' });
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });

  it('S2i: a provider 401/403 marks the connection broken; other failures do not', async () => {
    for (const code of [401, 403]) {
      const t = await tenant('vck_broken_0123456789');
      fake.reply({}, code);
      await expect(completeJson(t.ctx, params)).rejects.toMatchObject({ code: 'key_rejected' });
      expect(await status(t.accountId)).toBe('broken');
    }
    const t = await tenant('vck_flaky_0123456789');
    fake.reply({}, 500);
    await expect(completeJson(t.ctx, params)).rejects.toMatchObject({ code: 'http_error', status: 500 });
    expect(await status(t.accountId)).not.toBe('broken');
  });
});
