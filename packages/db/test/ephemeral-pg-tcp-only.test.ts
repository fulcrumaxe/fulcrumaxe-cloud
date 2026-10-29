import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';

/**
 * The test Postgres cluster listens on loopback TCP only. The runner's sandbox refuses
 * socket(AF_UNIX), so a cluster with a socket directory could not start inside a job
 * (D#6 R7e). Production is unchanged; this is the throwaway test cluster.
 */
describe('ephemeral Postgres is TCP on loopback, with no Unix socket', () => {
  const PREFIX = 'fx-tcponly-pg-';
  let pg: EphemeralPostgres | undefined;
  // A private root: other agents' clusters in the shared tmpdir never enter the count.
  const root = mkdtempSync(path.join(tmpdir(), 'tcponly-root-'));
  afterAll(() => {
    pg?.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('listens on 127.0.0.1 at an OS-assigned port, configures no socket directory, and creates no socket file', async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_tcponly_test', tmpPrefix: PREFIX, tmpRoot: root });
    expect(pg.url).toBe(`postgres://postgres@127.0.0.1:${pg.port}/fx_tcponly_test`);
    expect(pg.port).toBeGreaterThan(1023);

    const dirs = readdirSync(root).filter((n) => n.startsWith(PREFIX));
    expect(dirs).toHaveLength(1);
    const dir = path.join(root, dirs[0]!);
    const conf = readFileSync(path.join(dir, 'data', 'postgresql.conf'), 'utf8');
    expect(conf).toMatch(/^listen_addresses = '127\.0\.0\.1'$/m);
    expect(conf).toMatch(/^unix_socket_directories = ''$/m);
    expect(readdirSync(dir).filter((n) => n.startsWith('.s.PGSQL'))).toEqual([]);

    const pool = createPool(pg.url);
    try {
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
