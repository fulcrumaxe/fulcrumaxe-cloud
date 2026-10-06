import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { Pool } from 'pg';
import { createErrorReporter } from '@fx/telemetry';
import { createPool } from '../src/pool.js';
import { createPgErrorSink, type PgErrorSink } from '../src/errorSink.js';
import { PLATFORM_WIDE_TABLES } from '../src/platformWideTables.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { startTlsTerminatingProxy, type TlsProxy } from './helpers/pgTls.js';

/**
 * The error sink against the real local Postgres, as the application logs in: `app_user`, through a
 * TLS-terminating proxy (the Neon shape), so the client verifies TLS the way it does on the hosted database.
 * What it cannot fake: Neon's pooler (PgBouncer) and its public-CA certificate chain.
 */
type Row = { service: string; route: string; stage: string; code: string; count: string };

let admin: Pool;
let proxy: TlsProxy;
let appPool: Pool;
let queries: unknown[][] = [];

const appUserUrl = (port: number): string => {
  const u = new URL(process.env.DATABASE_URL_APP_USER!);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  u.search = '';
  return u.toString();
};

/** The pool the sink gets: app_user over the proxy, with every error_event_record call recorded. */
const countingPool = { query: (text: string, values: unknown[]) => (queries.push(values), appPool.query(text, values)) };

const rows = async (): Promise<Row[]> =>
  (await admin.query<Row>('SELECT service, route, stage, code, count FROM error_events ORDER BY service, route, stage, code')).rows;

/** A clock the tests move by hand. */
function clock(start = 1_000_000) {
  const c = { t: start };
  return { c, now: () => c.t };
}

function harness(extra: { pool?: { query(text: string, values: unknown[]): Promise<unknown> }; maxWritesPerMinute?: number } = {}) {
  const { c, now } = clock();
  const scheduled: Promise<unknown>[] = [];
  const lines: string[] = [];
  const sink: PgErrorSink = createPgErrorSink({
    pool: extra.pool ?? countingPool,
    now,
    schedule: (p) => void scheduled.push(p),
    ...(extra.maxWritesPerMinute ? { maxWritesPerMinute: extra.maxWritesPerMinute } : {}),
  });
  const reporter = createErrorReporter({ service: 'web', sink, write: (l) => lines.push(l), now });
  const settle = async (): Promise<void> => void (await Promise.all(scheduled.splice(0)));
  return { c, sink, reporter, lines, settle };
}

describe('error sink over TLS as app_user (0702)', () => {
  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    const upstream = new URL(process.env.DATABASE_URL!);
    proxy = await startTlsTerminatingProxy(Number(upstream.port));
    appPool = new pg.Pool({ connectionString: appUserUrl(proxy.port), ssl: { ca: proxy.ca }, max: 4 });
  });

  afterAll(async () => {
    await appPool.end();
    await proxy.close();
    await admin.end();
  });

  beforeEach(async () => {
    queries = [];
    await admin.query('TRUNCATE error_events');
  });

  it('really connects as app_user, over verified TLS', async () => {
    const { rows: who } = await appPool.query('SELECT current_user AS u');
    expect(who[0].u).toBe('app_user');
    expect(proxy.handshakes).toBeGreaterThan(0);
  });

  describe('criterion 4: first occurrence at once, then coalesced', () => {
    it('writes the first report before any flush, then counts 50 more within the window into one row', async () => {
      const { c, reporter, sink, settle } = harness();
      const err = Object.assign(new Error('boom token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), { code: 'ECONNRESET' });
      reporter.reportError(err, { stage: 'sync', route: '/api/v1/runs' });
      await settle();
      // Written, with no flush and no timer having run.
      expect(await rows()).toEqual([{ service: 'web', route: '/api/v1/runs', stage: 'sync', code: 'ECONNRESET', count: '1' }]);
      expect(queries).toHaveLength(1);

      for (let i = 0; i < 50; i++) {
        c.t += 100;
        reporter.reportError(err, { stage: 'sync', route: '/api/v1/runs' });
      }
      await sink.flush();
      expect(queries).toHaveLength(1); // inside the 10 s window: nothing more sent
      expect((await rows())[0]!.count).toBe('1');

      c.t += 10_000;
      await sink.flush();
      expect(queries).toHaveLength(2); // one more write for the whole window, not 50
      const after = await rows();
      expect(after).toHaveLength(1);
      expect(after[0]!.count).toBe('51'); // equals the calls made, never more
      sink.close();
    });

    it('two classes give two rows, and no value sent to the database carries the message', async () => {
      const { reporter, sink, settle } = harness();
      reporter.reportError(new Error('first octo/repo'), { stage: 'sync', route: '/api/v1/runs' });
      reporter.reportError(Object.assign(new Error('second'), { code: '23505' }), { stage: 'write', route: '/api/v1/runs' });
      await settle();
      const stored = await rows();
      expect(stored.map((r) => [r.stage, r.code, r.count])).toEqual([
        ['sync', 'other', '1'],
        ['write', '23505', '1'],
      ]);
      expect(JSON.stringify(queries)).not.toMatch(/octo|first|second|ghp_/);
      sink.close();
    });
  });

  describe('criterion 5: only the definer writes the table', () => {
    it('app_user is refused a direct INSERT, UPDATE, DELETE and SELECT, and succeeds through the function', async () => {
      const insert = `INSERT INTO error_events (bucket, service, route, stage, code, count, first_seen_at, last_seen_at)
                      VALUES (now(), 'web', '/', 'x', 'other', 1, now(), now())`;
      await expect(appPool.query(insert)).rejects.toMatchObject({ code: '42501' });
      await appPool.query("SELECT error_event_record('web', '/', 'x', 'other', 1)");
      await expect(appPool.query("UPDATE error_events SET count = 99 WHERE service = 'web'")).rejects.toMatchObject({ code: '42501' });
      await expect(appPool.query('DELETE FROM error_events')).rejects.toMatchObject({ code: '42501' });
      await expect(appPool.query('SELECT * FROM error_events')).rejects.toMatchObject({ code: '42501' });
      expect(await rows()).toHaveLength(1);
    });

    it('the function runs as a NOLOGIN, member-less owner whose only table privileges are on error_events', async () => {
      const role = await admin.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
                (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles mr ON mr.oid = m.member WHERE m.roleid = r.oid AND NOT mr.rolsuper) AS members
           FROM pg_roles r WHERE rolname = 'error_event_writer'`,
      );
      expect(role.rows[0]).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, members: 0 });
      const fn = await admin.query(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef,
                has_function_privilege('app_user', oid, 'EXECUTE') AS app_exec,
                has_function_privilege('platform_ops', oid, 'EXECUTE') AS ops_exec
           FROM pg_proc WHERE proname = 'error_event_record'`,
      );
      expect(fn.rows).toEqual([{ owner: 'error_event_writer', prosecdef: true, app_exec: true, ops_exec: false }]);
      // No privilege on any other relation, table-level or column-level.
      const others = await admin.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            AND c.relname <> 'error_events'
            AND (has_table_privilege('error_event_writer', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR (c.relkind <> 'S' AND has_any_column_privilege('error_event_writer', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
          ORDER BY 1`,
      );
      expect(others.rows.map((r) => r.relname)).toEqual([]);
      // On error_events itself: SELECT, INSERT, UPDATE and not DELETE or TRUNCATE.
      const own = await admin.query(
        `SELECT has_table_privilege('error_event_writer', 'error_events', 'SELECT') AS s,
                has_table_privilege('error_event_writer', 'error_events', 'INSERT') AS i,
                has_table_privilege('error_event_writer', 'error_events', 'UPDATE') AS u,
                has_table_privilege('error_event_writer', 'error_events', 'DELETE') AS d,
                has_table_privilege('error_event_writer', 'error_events', 'TRUNCATE') AS t`,
      );
      expect(own.rows[0]).toEqual({ s: true, i: true, u: true, d: false, t: false });
    });
  });

  describe('criterion 6: the 200-class cap, and the per-instance write cap', () => {
    it('writes the 201st distinct class of the hour as error_overflow, even from a direct SQL call', async () => {
      await admin.query(`SELECT error_event_record('web', '/', 'stage_' || i, 'other', 1) FROM generate_series(1, 200) AS i`);
      expect((await rows()).filter((r) => r.code !== 'error_overflow')).toHaveLength(200);

      await appPool.query("SELECT error_event_record('web', '/api/:id', 'brand_new', 'ECONNRESET', 1)");
      await appPool.query("SELECT error_event_record('web', '/api/:id', 'brand_new_too', 'ECONNRESET', 4)");
      const overflow = (await rows()).filter((r) => r.code === 'error_overflow');
      expect(overflow).toEqual([{ service: 'platform', route: '/', stage: 'overflow', code: 'error_overflow', count: '5' }]);
      expect((await rows()).filter((r) => r.stage.startsWith('brand_new'))).toEqual([]);

      // A class already recorded keeps counting under its own name.
      await appPool.query("SELECT error_event_record('web', '/', 'stage_1', 'other', 3)");
      expect((await rows()).find((r) => r.stage === 'stage_1')!.count).toBe('4');
    });

    it('does not let a caller choose the reserved overflow code, or a label outside its pattern', async () => {
      await appPool.query("SELECT error_event_record('web', '/', 'x', 'error_overflow', 1)");
      expect((await rows())[0]).toMatchObject({ stage: 'x', code: 'other' });
      for (const bad of [
        "error_event_record('Web', '/', 'x', 'other', 1)",
        "error_event_record('web', '/', 'X', 'other', 1)",
        "error_event_record('web', 'no-slash', 'x', 'other', 1)",
        "error_event_record('web', '/', 'x', 'octo/repo', 1)",
      ]) {
        const result = appPool.query(`SELECT ${bad}`);
        if (bad.includes('octo')) {
          await result; // a code that is not shaped like one is stored as other, not refused
          expect((await rows()).map((r) => r.code)).not.toContain('octo/repo');
        } else {
          await expect(result).rejects.toMatchObject({ code: '22023' });
        }
      }
    });

    it('never issues more than 20 writes in a minute from one instance; the rest wait for the window', async () => {
      const { c, reporter, sink, settle } = harness();
      for (let i = 0; i < 30; i++) reporter.reportError(new Error('x'), { stage: `stage_${i}`, route: '/api/v1/runs' });
      await settle();
      await sink.flush({ force: true });
      expect(queries).toHaveLength(20);
      expect(await rows()).toHaveLength(20);

      c.t += 30_000;
      await sink.flush({ force: true });
      expect(queries).toHaveLength(20); // still the same minute

      c.t += 31_000;
      await sink.flush({ force: true });
      await settle();
      expect(queries).toHaveLength(30);
      expect(await rows()).toHaveLength(30);
      sink.close();
    });

    it('a cap-held first occurrence is written once, not twice, when its turn comes', async () => {
      const { c, reporter, sink, settle } = harness({ maxWritesPerMinute: 1 });
      reporter.reportError(new Error('x'), { stage: 'one', route: '/' });
      reporter.reportError(new Error('x'), { stage: 'two', route: '/' });
      reporter.reportError(new Error('x'), { stage: 'two', route: '/' });
      await settle();
      c.t += 61_000;
      await sink.flush();
      const counts = Object.fromEntries((await rows()).map((r) => [r.stage, r.count]));
      expect(counts).toEqual({ one: '1', two: '2' });
      sink.close();
    });
  });

  describe('criterion 7: a sink that cannot connect changes nothing for the caller', () => {
    it('returns normally, still writes the stdout line, and raises no unhandled rejection', async () => {
      const closed = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
          const port = (s.address() as net.AddressInfo).port;
          s.close(() => resolve(port));
        });
      });
      const deadPool = new pg.Pool({ connectionString: appUserUrl(closed), ssl: { ca: proxy.ca }, max: 1, connectionTimeoutMillis: 500 });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { reporter, sink, lines, settle } = harness({ pool: deadPool });
        expect(() => reporter.reportError(new Error('x'), { stage: 'sync', route: '/api/v1/runs' })).not.toThrow();
        reporter.reportError(new Error('x'), { stage: 'sync', route: '/api/v1/runs' });
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'error.reported', stage: 'sync', error_name: 'Error' });
        await settle();
        await sink.flush({ force: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(unhandled).not.toHaveBeenCalled();
        sink.close();
      } finally {
        process.off('unhandledRejection', unhandled);
        await deadPool.end();
      }
    });
  });

  describe('criterion 8: the table holds no identity or free text, and is registered', () => {
    it('has no account_id, user_id, message or stack column', async () => {
      const { rows: cols } = await admin.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'error_events' ORDER BY ordinal_position",
      );
      const names = cols.map((c) => c.column_name);
      expect(names).toEqual(['bucket', 'service', 'route', 'stage', 'code', 'count', 'first_seen_at', 'last_seen_at']);
      for (const forbidden of ['account_id', 'user_id', 'message', 'stack']) expect(names).not.toContain(forbidden);
    });

    it('is listed in PLATFORM_WIDE_TABLES, and the RLS inventory passes with it (and reports it without the listing)', async () => {
      expect(PLATFORM_WIDE_TABLES).toContain('error_events');
      const client = await admin.connect();
      try {
        expect(await findRlsViolations(client)).toEqual([]);
        const without = PLATFORM_WIDE_TABLES.filter((t) => t !== 'error_events');
        expect(await findRlsViolations(client, without)).toContain('error_events');
      } finally {
        client.release();
      }
    });
  });
});
