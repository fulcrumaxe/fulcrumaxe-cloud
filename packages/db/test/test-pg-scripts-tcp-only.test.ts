import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The throwaway-cluster scripts start Postgres on loopback TCP only, like the vitest harness
 * (ephemeral-pg-tcp-only.test.ts). The runner's sandbox refuses socket(AF_UNIX), so a cluster with
 * a socket directory cannot start inside a job. This pins the scripts' text: the generated config
 * and every client call.
 */
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Every package's test-pg.sh is found by scanning, so a new one cannot skip the pin.
const PACKAGE_SCRIPTS = readdirSync(packages)
  .map((pkg) => `${pkg}/scripts/test-pg.sh`)
  .filter((rel) => existsSync(path.join(packages, rel)));
const SCRIPTS = [...PACKAGE_SCRIPTS, 'db/scripts/replay-merge-order.sh'];

it('covers every known package script', () => {
  expect(PACKAGE_SCRIPTS).toEqual(expect.arrayContaining(['core', 'db', 'model-connection', 'reconcile', 'webhooks'].map((p) => `${p}/scripts/test-pg.sh`)));
});

function lines(rel: string): string[] {
  return readFileSync(path.join(packages, rel), 'utf8').split('\n');
}

describe.each(SCRIPTS)('%s starts its cluster without a Unix socket', (rel) => {
  const text = lines(rel).join('\n');

  it('writes an empty unix_socket_directories and a loopback listen address', () => {
    expect(text).toMatch(/echo "unix_socket_directories = ''"/);
    expect(text).toMatch(/echo "listen_addresses = '127\.0\.0\.1'"/);
    expect(text).not.toMatch(/unix_socket_directories = '[^']/);
  });

  it('never points a client at a socket directory', () => {
    expect(text).not.toMatch(/PGHOST=/);
    expect(text).not.toMatch(/-h\s+"?\$\{?PG_TMP_DIR/);
    expect(text).not.toMatch(/host=\$/);
    const clients = lines(rel).filter((l) => /^\s*(createdb|psql|PSQL=\(psql)\b/.test(l));
    for (const call of clients) expect(call).toMatch(/-h 127\.0\.0\.1 -p "\$PG_PORT"/);
  });

  it('connects test processes by 127.0.0.1 URL when it exports one', () => {
    for (const l of lines(rel).filter((x) => /^export DATABASE_URL/.test(x))) {
      expect(l).toMatch(/@127\.0\.0\.1:\$\{PG_PORT\}\//);
    }
  });
});
