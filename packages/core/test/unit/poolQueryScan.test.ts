import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', '..', 'src');

/**
 * H06 pass/fail item 2: "Every DB access in packages/core goes through
 * withTenant. A test scans for direct pool.query use outside packages/db
 * and fails on a match." withTenant itself lives in packages/db; within
 * packages/core the two sanctioned chokepoints are withTenant.ts's
 * re-export and withPlatformOps.ts (the platform_ops sibling this
 * package adds for the account-less lookups withTenant can't do -- see
 * that file's own doc comment). Every other file must reach Postgres
 * only through a `PoolClient` handed to it inside one of those two
 * callbacks -- never by holding a `Pool` and calling `.query`/`.connect`
 * on it directly.
 *
 * Matches on the receiver's name, not its static type (a pure text scan
 * has no type information) -- every Pool variable in this codebase is
 * named ending in "Pool" (appUserPool, platformOpsPool, ...) or is
 * literally named `pool` (withPlatformOps.ts's own parameter), so
 * `<name>Pool.query(` / `<name>Pool.connect(` / bare `pool.query(` /
 * `pool.connect(` (optionally through a member access like
 * `this.pool.query(`) is the direct-access pattern this forbids.
 * `client.query(...)` inside a withTenant/withPlatformOps callback is the
 * sanctioned shape and is not matched by this pattern at all.
 *
 * Security fix round item 4: the prefix before `[Pp]ool` used to be
 * mandatory (`[A-Za-z_][A-Za-z0-9_]*`, one-or-more), which requires at
 * least one character before the FULL literal "pool"/"Pool" -- so it
 * matched "myPool.query(" but not bare "pool.query(" itself (there's no
 * room left for a mandatory extra character once "pool" is spelled out).
 * `membership.ts`, `authorize.ts` and `scopedAccess.ts` all take a `pool`
 * parameter, so a direct `pool.query(...)` added to any of them would
 * have passed this scan undetected. Making the prefix group optional
 * closes that gap while still matching every previously-caught form.
 */
const FORBIDDEN_DIRECT_ACCESS = /\b(?:[A-Za-z_][A-Za-z0-9_]*)?[Pp]ool\.(query|connect)\(/;

const ALLOWED_FILES = new Set(['tenancy/withTenant.ts', 'tenancy/withPlatformOps.ts']);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no direct Pool.query/Pool.connect outside the withTenant/withPlatformOps chokepoints', () => {
  const files = listTsFiles(SRC_DIR);

  it('scanned at least the files this test knows about (guards against an empty/miscounted scan)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    const relative = path.relative(SRC_DIR, file);
    it(`${relative} has no direct pool.query/pool.connect call`, () => {
      if (ALLOWED_FILES.has(relative)) {
        return;
      }
      const contents = readFileSync(file, 'utf8');
      expect(contents).not.toMatch(FORBIDDEN_DIRECT_ACCESS);
    });
  }

  it('the scan itself actually catches a violation (proves it is not vacuous)', () => {
    const violation = 'export async function bad(somePool) { return somePool.query("select 1"); }';
    expect(violation).toMatch(FORBIDDEN_DIRECT_ACCESS);
  });

  // Security fix round item 4: these three forms previously slipped past
  // the regex entirely (see the doc comment on FORBIDDEN_DIRECT_ACCESS).
  it.each([
    ['pool.query(', 'pool.query("select 1")'],
    ['pool.connect(', 'await pool.connect()'],
    ['this.pool.query(', 'return this.pool.query("select 1")'],
  ])('now matches bare %s', (_label, snippet) => {
    expect(snippet).toMatch(FORBIDDEN_DIRECT_ACCESS);
  });

  it('the negative control (client.query inside a chokepoint callback) still does not match', () => {
    const sanctioned = 'return withTenant(pool, accountId, async (client) => client.query("select 1"));';
    expect(sanctioned).not.toMatch(FORBIDDEN_DIRECT_ACCESS);
  });

  it('the only file in src/ that matches the chokepoint pattern is the allowlisted withPlatformOps.ts', () => {
    const matches = files
      .filter((file) => FORBIDDEN_DIRECT_ACCESS.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_DIR, file));
    expect(matches).toEqual(['tenancy/withPlatformOps.ts']);
  });
});
