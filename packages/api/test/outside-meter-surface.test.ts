import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { mintGatewayTag } from '@fx/spend';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runInsightResponseSchema } from '../src/routes/run-insight.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** D#221 OM-2c [pg]: what the run page shows of the outside meter, and that its per-run tag leaves the server on no route. */
describe('outside meter: run detail text and the tag in no response (D#221 OM-2c)', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    process.env.FX_CURSOR_KEY_V1 = Buffer.alloc(32, 7).toString('base64'); // /api/v1/events seals its cursor
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function get(urlPath: string, identity: { userId: string; accountId: string }): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    return handleApiRequest(new Request(`http://localhost${urlPath}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  /** A tagged run on an item, with an event, and the outside-meter columns as the sweep would have left them. */
  async function seedTaggedRun(accountId: string, om: { state?: string | null; reason?: string | null; trueUp?: number | null } = {}) {
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, accountId, Math.floor(Math.random() * 1e9)]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened', 7)`, [itemId, accountId, repoId]);
    const runId = randomUUID();
    const tag = mintGatewayTag();
    const keyRef = 'a'.repeat(64);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, gateway_report_tag, om_key_ref, om_state, om_reason, om_true_up_usd)
       VALUES ($1, $2, $3, 'executor', 'production', 'running', $4, $5, $6, $7, $8)`,
      [runId, accountId, itemId, tag, keyRef, om.state === undefined ? 'pending' : om.state, om.reason ?? null, om.trueUp ?? null],
    );
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', '{"to":"running"}'::jsonb)`, [accountId, runId]);
    return { runId, itemId, tag, keyRef };
  }

  const keysDeep = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysDeep) : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]) : [];

  it('every route that returns a run answers a tagged run with no tag value, no tag key and no key reference', async () => {
    const who = await seedAccountWithMember(admin);
    const r = await seedTaggedRun(who.accountId);
    const paths = [
      '/api/v1/runs', `/api/v1/runs/${r.runId}`, `/api/v1/runs/${r.runId}/insight`, `/api/v1/runs/${r.runId}/events`,
      `/api/v1/runs/${r.runId}/events/export`, '/api/v1/events', `/api/v1/work-items/${r.itemId}`,
      `/api/v1/work-items/${r.itemId}/activity`, `/api/v1/work-items/${r.itemId}/timeline`,
    ];
    for (const p of paths) {
      const res = await get(p, who);
      const text = await res.text();
      expect(res.status, p).toBe(200);
      if (p !== '/api/v1/events') expect([r.runId, r.itemId, 'run.status_changed'].some((m) => text.includes(m)), `${p} shows nothing of the run`).toBe(true); // so "no tag" is not vacuous
      expect(text.includes(r.tag), `${p} holds the tag`).toBe(false);
      expect(text.includes(r.keyRef), `${p} holds the key reference`).toBe(false);
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown); }
      expect(keysDeep(body).filter((k) => k === 'gateway_report_tag' || k === 'om_key_ref'), p).toEqual([]);
    }
  });

  it('no source file reads agent_runs with a star (SELECT * or UPDATE … RETURNING *)', () => {
    const hits: string[] = [];
    const STAR_READS = [/SELECT\s+(\w+\.)?\*\s+FROM\s+agent_runs/i, /UPDATE\s+agent_runs\b[^`;]*?RETURNING\s+(\w+\.)?\*/i];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === 'test' || name === 'migrations') continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && STAR_READS.some((re) => re.test(readFileSync(full, 'utf8')))) hits.push(path.relative(REPO_ROOT, full));
      }
    };
    for (const root of ['packages', 'apps']) for (const pkg of readdirSync(path.join(REPO_ROOT, root))) {
      const src = path.join(REPO_ROOT, root, pkg);
      if (statSync(src).isDirectory()) walk(src);
    }
    expect(hits).toEqual([]);
  });

  it('run detail shows exactly one of five states, each with its sentence and a named reason, never null', async () => {
    const who = await seedAccountWithMember(admin);
    const cases: { om: Parameters<typeof seedTaggedRun>[1]; state: string; reason: string | null; text: string }[] = [
      { om: { state: 'pending' }, state: 'pending', reason: null, text: 'Checking with the AI Gateway' },
      { om: { state: 'matches' }, state: 'matches', reason: null, text: 'Matches the gateway' },
      { om: { state: 'higher', trueUp: 1.5 }, state: 'higher', reason: null, text: 'Gateway figure higher: $1.50 added' },
      { om: { state: 'unavailable', reason: 'plan_not_entitled' }, state: 'unavailable', reason: 'plan_not_entitled', text: 'Outside check unavailable: plan not entitled' },
      { om: { state: 'unavailable', reason: 'gateway_error' }, state: 'unavailable', reason: 'gateway_error', text: 'Outside check unavailable: gateway error' },
      { om: { state: 'unavailable', reason: 'no_metered_figure' }, state: 'unavailable', reason: 'no_metered_figure', text: 'Outside check unavailable: no metered figure' },
      { om: { state: 'unavailable', reason: 'floor_unmet', trueUp: 1 }, state: 'unavailable', reason: 'floor_unmet', text: 'Outside check unavailable: gateway saw fewer calls than the meter. $1.00 added' },
      { om: { state: 'unavailable', reason: 'floor_unmet' }, state: 'unavailable', reason: 'floor_unmet', text: 'Outside check unavailable: gateway saw fewer calls than the meter' },
      { om: { state: 'unavailable', reason: 'trueup_over_ceiling' }, state: 'unavailable', reason: 'trueup_over_ceiling', text: 'Outside check unavailable: gateway figure held for review' },
      { om: { state: null }, state: 'off', reason: null, text: 'Outside check off' },
    ];
    for (const c of cases) {
      const r = await seedTaggedRun(who.accountId, c.om);
      const res = await get(`/api/v1/runs/${r.runId}/insight`, who);
      const body = (await res.json()) as { outside_meter: { state: string; reason: string | null; text: string } };
      expect(runInsightResponseSchema.parse(body)).toEqual(body);
      expect(body.outside_meter).toMatchObject({ state: c.state, reason: c.reason, text: c.text });
      expect(c.text).not.toMatch(/null|undefined/);
    }
  });
});
