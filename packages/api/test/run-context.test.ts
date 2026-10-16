import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { RunContextPanel } from '@fx/core/src/runs/contextPanel.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runContextResponseSchema, runContextRoutes } from '../src/routes/run-context.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const SHA = 'a'.repeat(64);

/** D#600 CX-8: GET /api/v1/runs/{id}/context against real Postgres (RLS forced on the ledger): what it reads, what it hides, who may call it. */
describe('GET /api/v1/runs/{id}/context (D#600 CX-8)', { timeout: 60_000 }, () => {
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
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function get(id: string, identity: { userId: string; accountId: string }): Promise<Response> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    return handleApiRequest(new Request(`http://localhost/api/v1/runs/${id}/context`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function seedRun(accountId: string, p: { runtime?: string; status?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', $3, $4)`, [id, accountId, p.runtime ?? 'production', p.status ?? 'succeeded']);
    return id;
  }

  async function seedLedger(accountId: string, runId: string, p: Record<string, unknown>): Promise<void> {
    const v = {
      sections: [],
      first: null,
      peak: null,
      read: null,
      write: null,
      memory: null,
      tools: {},
      compactions: 0,
      basis: 'partial',
      ...p,
    };
    await admin.query(
      `INSERT INTO run_context_ledger (account_id, run_id, sections, first_turn_input_tokens, peak_context_tokens, cache_read_tokens, cache_write_tokens, memory_tokens, tool_output_bytes, compactions, basis)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [accountId, runId, JSON.stringify(v.sections), v.first, v.peak, v.read, v.write, v.memory, JSON.stringify(v.tools), v.compactions, v.basis],
    );
  }

  it('registers one session-only member GET with a read rate class', () => {
    expect(runContextRoutes).toHaveLength(1);
    const [route] = runContextRoutes;
    expect(route!.method).toBe('GET');
    expect(route!.principals).toEqual(['session']);
    expect(route!.minRole).toBe('member');
    expect(route!.idempotency).toBe('never');
    expect(ROUTES).toContain(route);
  });

  it('reads a measured ledger: sections in stored order with trimmed bytes, tokens, cache, tools largest first and compactions; no hash', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const id = await seedRun(accountId);
    await seedLedger(accountId, id, {
      basis: 'measured',
      sections: [
        { code: 'card', bytes: 5000, sha256: SHA, trimmed_bytes: 0 },
        { code: 'spec', bytes: 12000, sha256: SHA, trimmed_bytes: 700 },
      ],
      first: 9000,
      peak: 150000,
      read: 4000000,
      write: 300000,
      memory: 900,
      tools: { Grep: 10, Read: 4000, Bash: 200 },
      compactions: 2,
    });
    const res = await get(id, { accountId, userId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunContextPanel;
    expect(runContextResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      run_id: id,
      runtime: 'production',
      recorded: true,
      basis: 'measured',
      first_turn_input_tokens: 9000,
      peak_context_tokens: 150000,
      cache_read_tokens: 4000000,
      cache_write_tokens: 300000,
      memory_tokens: 900,
      compactions: 2,
      recalled_memory: [],
      repo_map_version: null,
    });
    expect(body.sections).toEqual([
      { code: 'card', bytes: 5000, trimmed_bytes: 0 },
      { code: 'spec', bytes: 12000, trimmed_bytes: 700 },
    ]);
    expect(body.tool_output).toEqual([
      { tool: 'Read', bytes: 4000 },
      { tool: 'Bash', bytes: 200 },
      { tool: 'Grep', bytes: 10 },
    ]);
    expect(JSON.stringify(body)).not.toContain(SHA);
  });

  it('a partial row keeps its missing figures null, never 0', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const id = await seedRun(accountId);
    await seedLedger(accountId, id, { basis: 'partial', sections: [{ code: 'card', bytes: 10, sha256: SHA, trimmed_bytes: 0 }] });
    const body = (await (await get(id, { accountId, userId })).json()) as RunContextPanel;
    expect(runContextResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({ recorded: true, basis: 'partial', first_turn_input_tokens: null, peak_context_tokens: null, cache_read_tokens: null, cache_write_tokens: null, memory_tokens: null, tool_output: [], compactions: 0 });
  });

  it('a run with no ledger row answers recorded false with empty lists, for a finished run and a live one', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    for (const status of ['succeeded', 'running']) {
      const id = await seedRun(accountId, { status });
      const res = await get(id, { accountId, userId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RunContextPanel;
      expect(runContextResponseSchema.parse(body)).toEqual(body);
      expect(body).toMatchObject({ status, recorded: false, basis: null, sections: [], tool_output: [], first_turn_input_tokens: null, compactions: null });
    }
  });

  it('a runner run is returned as sizes and counts only (no text field anywhere in the body)', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const id = await seedRun(accountId, { runtime: 'runner' });
    await seedLedger(accountId, id, {
      basis: 'measured',
      sections: [{ code: 'map', bytes: 100, sha256: SHA, trimmed_bytes: 0 }],
      first: 1,
      peak: 2,
      read: 3,
      write: 4,
      tools: { Read: 5 },
    });
    const body = (await (await get(id, { accountId, userId })).json()) as Record<string, unknown>;
    expect(body.runtime).toBe('runner');
    expect(body.recalled_memory).toEqual([]);
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(body);
    // The only strings are the run's id, its runtime and status, the basis and the closed section and tool names.
    expect(strings.sort()).toEqual([id, 'map', 'measured', 'Read', 'runner', 'succeeded'].sort());
  });

  describe('D#600 CX-8b: recalled memory and the map version from the run\'s recorded inputs', () => {
    const MAP_HASH = 'c'.repeat(64);
    async function entry(accountId: string, body: string, status = 'approved', version = 1): Promise<string> {
      const r = await admin.query<{ id: string }>(
        `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256, deleted_at)
         VALUES ($1, 'account', NULL, 'command', $2, 'person', $3, $4, $5, CASE WHEN $3 = 'deleted' THEN now() END) RETURNING id`,
        [accountId, body, status, version, createHash('sha256').update(body).digest('hex')],
      );
      return r.rows[0]!.id;
    }
    async function inputs(accountId: string, runId: string, ids: string[], versions: number[], mapVersion: string | null = '1', sha: string | null = MAP_HASH): Promise<void> {
      await admin.query(`INSERT INTO run_context_inputs (account_id, run_id, recalled_entry_ids, recalled_entry_versions, map_version, map_sha256) VALUES ($1, $2, $3::uuid[], $4::integer[], $5, $6)`, [accountId, runId, ids, versions, mapVersion, sha]);
    }

    it('lists the recalled entries in prompt order by name and id@version, and the map as v<format> · <12 hex of the raw-text hash>', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const id = await seedRun(accountId);
      await seedLedger(accountId, id, { basis: 'measured', first: 1, peak: 2 });
      const a = await entry(accountId, '  run   the pg tests\nwith the local harness', 'approved');
      const b = await entry(accountId, '\nonly a second line');
      await inputs(accountId, id, [b, a], [1, 1]);
      const body = (await (await get(id, { accountId, userId })).json()) as RunContextPanel;
      expect(runContextResponseSchema.parse(body)).toEqual(body);
      expect(body.recalled_memory).toEqual([
        { id: b, name: 'account/command', version: 1 },
        { id: a, name: 'run the pg tests', version: 1 },
      ]);
      expect(body.repo_map_version).toBe('v1 · cccccccccccc');
      expect(JSON.stringify(body)).not.toContain(MAP_HASH);
    });

    it('a deleted entry reads "Deleted entry" and its text is not returned; a run with no record lists nothing', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const id = await seedRun(accountId);
      await seedLedger(accountId, id, { basis: 'measured', first: 1, peak: 2 });
      const gone = await entry(accountId, 'secret deploy token location', 'deleted');
      await inputs(accountId, id, [gone], [1], null, null);
      const body = (await (await get(id, { accountId, userId })).json()) as RunContextPanel;
      expect(body.recalled_memory).toEqual([{ id: gone, name: 'Deleted entry', version: 1 }]);
      expect(body.repo_map_version).toBeNull();
      expect(JSON.stringify(body)).not.toContain('secret');
      const bare = await seedRun(accountId);
      await seedLedger(accountId, bare, { basis: 'measured', first: 1, peak: 2 });
      expect(((await (await get(bare, { accountId, userId })).json()) as RunContextPanel).recalled_memory).toEqual([]);
    });

    it('a runner run returns no memory name and no map even when a record exists', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const id = await seedRun(accountId, { runtime: 'runner' });
      await seedLedger(accountId, id, { basis: 'measured', first: 1, peak: 2 });
      const e = await entry(accountId, 'private name');
      await inputs(accountId, id, [e], [1]);
      const body = (await (await get(id, { accountId, userId })).json()) as RunContextPanel;
      expect(body.recalled_memory).toEqual([]);
      expect(body.repo_map_version).toBeNull();
      expect(JSON.stringify(body)).not.toContain('private name');
    });

    it("reads another account's entry (or a purged one) by the same label as a deleted one, and never names it", async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const id = await seedRun(a.accountId);
      await seedLedger(a.accountId, id, { basis: 'measured', first: 1, peak: 2 });
      const theirs = await entry(b.accountId, 'other tenant text');
      await inputs(a.accountId, id, [theirs], [1]);
      const body = (await (await get(id, a)).json()) as RunContextPanel;
      expect(JSON.stringify(body)).not.toContain('other tenant text');
      expect(body.recalled_memory).toEqual([{ id: theirs, name: 'Deleted entry', version: 1 }]);
    });
  });

  it("answers 404 for an unknown id, a malformed id and another account's run (RLS forced on the ledger)", async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const theirs = await seedRun(b.accountId);
    await seedLedger(b.accountId, theirs, { basis: 'measured', first: 1, peak: 2 });
    for (const id of [randomUUID(), 'not-a-uuid', theirs]) {
      const res = await get(id, a);
      expect(res.status, id).toBe(404);
    }
  });

  it('refuses a request with no session', async () => {
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/runs/${randomUUID()}/context`), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(401);
  });
});
