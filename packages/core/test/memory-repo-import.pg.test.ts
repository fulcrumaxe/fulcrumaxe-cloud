import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { MEMORY_IMPORT_MAX_BYTES, MEMORY_PENDING_MAX_PER_SCOPE, repoScopeRef } from '../src/memory/index.js';
import { capImportText, importRepoFile, pieces, splitInstructionFile, type ImportRepoFileInput } from '../src/memory/repoFileImport.js';

const LIVE_TOKEN = ['ghs', '_', 'Zq81LiveTokenValue', 'aB3dE5fG7hJ9kL'].join(''); // gitleaks:allow
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const FILE_SHA = 'c'.repeat(40);
const FILE_SHA2 = 'd'.repeat(40);

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const four = ['# Build', 'Run pnpm test before you push.', '## Style', 'Prefer named exports.', '## Review', 'Every change needs a second pair of eyes.', '## Deploy', 'Staging first, then production.'].join('\n');

/** D#601 MEM-5: the repo-file import, split and stored as proposals against a real Postgres (Neon shape: app_user, forced RLS, the definers). */
describe('memory repo-file import (D#601 MEM-5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let counter = 0;

  /** A fresh repository per test, so a test never sees another's entries. */
  async function repo(): Promise<{ repoId: string; ref: string }> {
    counter += 1;
    const repoId = randomUUID();
    const installId = randomUUID();
    const gh = 7_700_000 + counter + Math.floor(Math.random() * 1e6);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installId, a.accountId, gh]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repoId, a.accountId, installId, gh]);
    const node = `R_kgDOImport${counter}x${gh}`;
    await admin.query(`UPDATE repos SET gh_node_id = $2 WHERE id = $1`, [repoId, node]);
    return { repoId, ref: repoScopeRef(node, gh) };
  }
  const input = (repoId: string, text: string, extra: Partial<ImportRepoFileInput> = {}): ImportRepoFileInput => ({
    pool: appPool,
    accountId: a.accountId,
    repoId,
    path: 'CLAUDE.md',
    fileSha: FILE_SHA,
    sourceCommit: SHA1,
    text,
    liveSecrets: () => [],
    ...extra,
  });
  const rows = async (ref: string) => (await admin.query(`SELECT * FROM memory_entries WHERE account_id = $1 AND scope = 'repo' AND scope_ref = $2 ORDER BY created_at, id`, [a.accountId, ref])).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  describe('splitting (pure)', () => {
    it('cuts at headings of level 1 to 3, keeps the text before the first heading, and ignores a heading inside a code fence', () => {
      const text = ['intro line', '# One', 'a', '```', '# not a heading', '```', '#### deep heading stays', '## Two', 'b', '####### x'].join('\n');
      const out = splitInstructionFile(text);
      expect(out).toHaveLength(3);
      expect(out[0]).toBe('intro line');
      expect(out[1]).toContain('# not a heading');
      expect(out[1]).toContain('#### deep heading stays');
      expect(out[2]).toBe('## Two\nb\n####### x');
    });

    it('drops a section that is only a heading, and cuts a long section into pieces that each repeat the heading and fit a memory body', () => {
      expect(splitInstructionFile('# Empty\n\n## Next\nbody')).toEqual(['## Next\nbody']);
      const long = `# Long\n${Array.from({ length: 80 }, (_, i) => `line number ${i} with some padding text`).join('\n')}`;
      const out = splitInstructionFile(long);
      expect(out.length).toBeGreaterThan(2);
      for (const piece of out) {
        expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(1024);
        expect(piece.startsWith('# Long\n')).toBe(true);
      }
    });

    it('cuts a single line longer than a body at a character boundary', () => {
      const out = splitInstructionFile(`# Wide\n${'é'.repeat(1500)}`);
      expect(out.length).toBeGreaterThan(1);
      for (const piece of out) expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(1024);
      expect(out.join('')).not.toContain('�');
    });

    it('terminates and stays inside a body for a heading of any length: 957, 958, 959 and 998 bytes, and one longer than the whole cap', () => {
      for (const len of [957, 958, 959, 998, 2000, 40_000]) {
        const heading = `# ${'h'.repeat(len - 2)}`;
        for (const body of ['short body', 'b'.repeat(2500), `${'word '.repeat(300)}\n${'é'.repeat(900)}`]) {
          const started = Date.now();
          const out = splitInstructionFile(`${heading}\n${body}`);
          expect(Date.now() - started).toBeLessThan(1000);
          expect(out.length).toBeGreaterThan(0);
          expect(out.length).toBeLessThan(40);
          for (const piece of out) {
            expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(1024);
            expect(piece.startsWith('# hhh')).toBe(true);
          }
          // every character of the body is still in some piece
          const joined = out.map((p) => p.slice(p.indexOf('\n') + 1)).join('');
          expect(joined.replace(/\s/g, '')).toBe(body.replace(/\s/g, ''));
        }
      }
    });

    it('pieces ends for any limit, including zero, negative and smaller than one character, and every cut takes at least one character', () => {
      for (const limit of [-1000, -1, 0, 1, 3, 15, 16]) {
        for (const text of ['x'.repeat(200), '😀'.repeat(50), `a\n${'€'.repeat(30)}\nb`]) {
          const started = Date.now();
          const out = pieces(text, limit);
          expect(Date.now() - started).toBeLessThan(500);
          expect(out.join('').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
          for (const piece of out) expect(piece).not.toContain('�');
        }
      }
    });

    it('cuts an over-long heading with a marker, at a character boundary, and keeps a short one whole', () => {
      const [cut] = splitInstructionFile(`# ${'é'.repeat(900)}\nbody`);
      const first = cut!.split('\n')[0]!;
      expect(Buffer.byteLength(first)).toBeLessThanOrEqual(200);
      expect(first.endsWith('…')).toBe(true);
      expect(first).not.toContain('�');
      expect(splitInstructionFile('## Short heading\nbody')).toEqual(['## Short heading\nbody']);
    });

    it('cuts a 32 KiB single line in one linear pass, never inside a multi-byte character or a surrogate pair', () => {
      const started = Date.now();
      const flat = splitInstructionFile(`# T\n${'x'.repeat(32 * 1024)}`);
      expect(Date.now() - started).toBeLessThan(200);
      expect(flat.length).toBeGreaterThan(30);
      // a line of 2-, 3- and 4-byte characters, so the byte limit falls inside a character at most cuts
      const mixed = ['é', '€', '😀'].map((c) => c.repeat(4000)).join('');
      for (const line of [mixed, '😀'.repeat(8000), `a${'😀'.repeat(8000)}`, `ab${'€'.repeat(8000)}`]) {
        const t = Date.now();
        const out = splitInstructionFile(`# T\n${line}`);
        expect(Date.now() - t).toBeLessThan(200);
        for (const piece of out) {
          expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(1024);
          expect(piece).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
          expect(piece).not.toContain('�');
        }
        expect(out.map((p) => p.slice(p.indexOf('\n') + 1)).join('')).toBe(line);
      }
    });

    it('caps text at 32 KiB at a line break and says so; a file at the cap is whole', () => {
      const line = `${'x'.repeat(99)}\n`;
      const big = line.repeat(Math.ceil((40 * 1024) / line.length));
      const capped = capImportText(big);
      expect(capped.truncated).toBe(true);
      expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(MEMORY_IMPORT_MAX_BYTES);
      expect(capped.text.endsWith('x')).toBe(true);
      expect(capImportText('y'.repeat(MEMORY_IMPORT_MAX_BYTES))).toEqual({ text: 'y'.repeat(MEMORY_IMPORT_MAX_BYTES), truncated: false });
      expect(capImportText('é'.repeat(MEMORY_IMPORT_MAX_BYTES)).text).not.toContain('�');
    });
  });

  it('AC1: a file with 4 sections creates 4 proposals with author_kind import, proposed, expiring in 14 days, with commit, file sha and path, and nothing approved', async () => {
    const r = await repo();
    const out = await importRepoFile(input(r.repoId, four));
    expect(out).toMatchObject({ truncated: false, sections: 4, refused: [] });
    expect(out.stored).toHaveLength(4);
    const stored = await rows(r.ref);
    expect(stored).toHaveLength(4);
    for (const e of stored) {
      expect(e).toMatchObject({ author_kind: 'import', status: 'proposed', scope: 'repo', created_by: null, approved_by: null, kind: 'convention' });
      expect(e.provenance).toEqual({ source_path: 'CLAUDE.md', source_commit: SHA1, file_sha: FILE_SHA, input_trust_classes: ['untrusted'] });
      const days = (new Date(e.expires_at).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1 AND scope_ref = $2 AND status = 'approved'`, [a.accountId, r.ref])).rows[0].n).toBe(0);
    const audit = await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'memory.proposed' AND payload ->> 'author_kind' = 'import'`, [a.accountId]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(4);
  });

  it('AC2: running it again proposes nothing; after one section changes, exactly one new proposal; the new file sha and commit are on it', async () => {
    const r = await repo();
    await importRepoFile(input(r.repoId, four));
    const again = await importRepoFile(input(r.repoId, four));
    expect(again.stored).toEqual([]);
    expect(again.refused.map((x) => x.reason)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    const edited = four.replace('Prefer named exports.', 'Prefer named exports and no default exports.');
    const out = await importRepoFile(input(r.repoId, edited, { fileSha: FILE_SHA2, sourceCommit: SHA2 }));
    expect(out.stored).toHaveLength(1);
    expect(out.refused.map((x) => x.reason)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    const all = await rows(r.ref);
    expect(all).toHaveLength(5);
    expect(all[4].body).toContain('no default exports');
    expect(all[4].provenance).toMatchObject({ source_commit: SHA2, file_sha: FILE_SHA2 });
  });

  it('a section that expired unread, or that a person rejected, is not proposed again by the next import', async () => {
    const r = await repo();
    const first = await importRepoFile(input(r.repoId, four));
    await admin.query(`UPDATE memory_entries SET status = 'expired' WHERE id = $1`, [first.stored[0]!.id]);
    await admin.query(`UPDATE memory_entries SET status = 'rejected' WHERE id = $1`, [first.stored[1]!.id]);
    const out = await importRepoFile(input(r.repoId, `${four}\n## New\nAnother rule.`, { fileSha: FILE_SHA2, sourceCommit: SHA2 }));
    expect(out.stored).toHaveLength(1);
    expect(out.refused.map((x) => x.reason)).toEqual(['already_proposed', 'already_proposed', 'duplicate', 'duplicate']);
  });

  it('the declined look-back applies: text a person rejected, retired, deleted or edited away is not proposed, whoever wrote it', async () => {
    const r = await repo();
    const sections = ['# A\nalpha rule', '# B\nbeta rule', '# C\ngamma rule', '# D\ndelta rule', '# E\nepsilon rule'];
    const statuses = ['rejected', 'retired', 'deleted', 'superseded'];
    for (const [i, status] of statuses.entries()) {
      await admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256, deleted_at)
         VALUES ($1, $2, 'repo', $3, 'fact', $4, 'person', $5, 1, $6, $7)`,
        [randomUUID(), a.accountId, r.ref, sections[i]!.replace('\n', ' '), status, sha(sections[i]!.replace('\n', ' ')), status === 'deleted' ? new Date() : null],
      );
    }
    const out = await importRepoFile(input(r.repoId, sections.join('\n')));
    expect(out.refused.map((x) => x.reason)).toEqual(['previously_declined', 'previously_declined', 'previously_declined', 'previously_declined']);
    expect(out.stored.map((x) => x.index)).toEqual([4]);
  });

  it('the look-back is the dial\'s own: a text a person rejected at account scope is not proposed, and a text only a time sweep retired is', async () => {
    const r = await repo();
    const row = (scope: string, ref: string | null, body: string, status: string) =>
      admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256)
         VALUES ($1, $2, $3, $4, 'fact', $5, 'person', $6, 1, $7)`,
        [randomUUID(), a.accountId, scope, ref, body, status, sha(body)],
      );
    await row('account', null, '# A alpha rule', 'rejected');
    await row('repo', r.ref, '# B beta rule', 'retired');
    await admin.query(
      `INSERT INTO audit_log (account_id, actor, action, payload) SELECT $1, 'system:memory_sweep', 'memory.retired', jsonb_build_object('entry_id', id::text) FROM memory_entries WHERE body = '# B beta rule' AND account_id = $1`,
      [a.accountId],
    );
    const out = await importRepoFile(input(r.repoId, '# A\nalpha rule\n# B\nbeta rule'));
    expect(out.refused.map((x) => x.reason)).toEqual(['previously_declined']);
    expect(out.stored.map((x) => x.index)).toEqual([1]);
  });

  it('an approved entry with the same words is a duplicate, not a second card', async () => {
    const r = await repo();
    await admin.query(
      `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256) VALUES ($1, $2, 'repo', $3, 'fact', $4, 'person', 'approved', 1, $5)`,
      [randomUUID(), a.accountId, r.ref, '# Build Run PNPM test before you push.', sha('# Build Run PNPM test before you push.')],
    );
    const out = await importRepoFile(input(r.repoId, '# Build\nRun pnpm test before you push.'));
    expect(out.stored).toEqual([]);
    expect(out.refused).toEqual([{ index: 0, reason: 'duplicate' }]);
  });

  it('AC3: a 40 KiB file is read to 32 KiB, says it was truncated, and nothing past the cap reaches a row', async () => {
    const r = await repo();
    // 400 lines of exactly 100 bytes, one new section for every 8 lines; 327 whole lines fit in 32 KiB.
    const lines = Array.from({ length: 400 }, (_, i) => `L${String(i).padStart(4, '0')} ${'x'.repeat(94)}`);
    const big = lines.map((l, i) => (i % 8 === 0 ? `## Block ${i / 8}\n${l}` : l)).join('\n');
    expect(Buffer.byteLength(big)).toBeGreaterThan(40 * 1024);
    const out = await importRepoFile(input(r.repoId, big));
    expect(out.truncated).toBe(true);
    expect(out.stored.length + out.refused.length).toBe(out.sections);
    expect(out.stored).toHaveLength(MEMORY_PENDING_MAX_PER_SCOPE);
    // At most 327 whole lines fit in 32 KiB (fewer with the headings), so the last block is cut short and no later line exists anywhere.
    expect(out.sections).toBeGreaterThanOrEqual(39);
    expect(out.sections).toBeLessThanOrEqual(41);
    const dump = JSON.stringify(await rows(r.ref));
    expect(dump).not.toContain('L0327');
    const small = await importRepoFile(input(r.repoId, 'x'.repeat(1000), { path: 'AGENTS.md' }));
    expect(small.truncated).toBe(false);
  });

  it('an import waits for the account intake lock: while another writer holds it nothing is stored, and after it is released the file is imported once', async () => {
    const r = await repo();
    const holder = await adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('memory_intake:' || $1::text, 0))`, [a.accountId]);
      let done = false;
      const pending = importRepoFile(input(r.repoId, four)).then((x) => ((done = true), x));
      await new Promise((res) => setTimeout(res, 400));
      expect(done).toBe(false);
      expect(await rows(r.ref)).toEqual([]);
      await holder.query('COMMIT');
      expect((await pending).stored).toHaveLength(4);
    } finally {
      holder.release();
    }
  });

  it('stops at 20 pending in the place: the rest are pending_full and nothing past the cap is stored', async () => {
    const r = await repo();
    const text = Array.from({ length: 23 }, (_, i) => `## S${i}\nunique rule number ${i}`).join('\n');
    const out = await importRepoFile(input(r.repoId, text));
    expect(out.stored).toHaveLength(MEMORY_PENDING_MAX_PER_SCOPE);
    expect(out.refused.map((x) => x.reason)).toEqual(['pending_full', 'pending_full', 'pending_full']);
    expect((await rows(r.ref)).filter((e) => e.status === 'proposed')).toHaveLength(MEMORY_PENDING_MAX_PER_SCOPE);
  });

  it('a section holding a credential shape or a live token value is refused, and no byte of it is in any row', async () => {
    const r = await repo();
    const text = ['# Deploy', `use token ${LIVE_TOKEN} here`, '# Keys', `key AKIA${'ABCDEFGHIJKLMNOP'}`, '# Fine', 'a harmless rule'].join('\n');
    const out = await importRepoFile(input(r.repoId, text, { liveSecrets: () => [LIVE_TOKEN] }));
    expect(out.refused).toEqual([
      { index: 0, reason: 'secret_detected' },
      { index: 1, reason: 'secret_detected' },
    ]);
    expect(out.stored).toHaveLength(1);
    const dump = JSON.stringify((await admin.query(`SELECT * FROM memory_entries WHERE account_id = $1`, [a.accountId])).rows) + JSON.stringify((await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1`, [a.accountId])).rows);
    expect(dump).not.toContain(LIVE_TOKEN);
    expect(dump).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('repo memory stays keyed on the repository node id and installation: a repository with no key refuses, and another account sees nothing', async () => {
    const r = await repo();
    await importRepoFile(input(r.repoId, four));
    await admin.query(`UPDATE repos SET gh_node_id = NULL WHERE id = $1`, [r.repoId]);
    await expect(importRepoFile(input(r.repoId, '# X\nnew words'))).rejects.toThrow(/no memory key/);
    const b = await seedAccount(admin, randomUUID());
    const theirs = await withTenant(appPool, b.accountId, async (c) => (await c.query(`SELECT 1 FROM memory_entries WHERE scope_ref = $1`, [r.ref])).rows);
    expect(theirs).toHaveLength(0);
  });

  it('refuses a path that is not one of the two files and a sha that is not a full sha, before anything is read', async () => {
    const r = await repo();
    await expect(importRepoFile(input(r.repoId, four, { path: '../etc/passwd' as never }))).rejects.toThrow(/instruction files/);
    await expect(importRepoFile(input(r.repoId, four, { fileSha: 'abc' }))).rejects.toThrow(/full shas/);
    await expect(importRepoFile(input(r.repoId, four, { sourceCommit: 'main' }))).rejects.toThrow(/full shas/);
    expect(await rows(r.ref)).toEqual([]);
  });
});
