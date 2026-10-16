import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { MemoryInputError, base64Forms, decideMemory, editMemory, holdsLiveSecret, prepareMemoryText, proposeMemory, repoScopeRef, type MemoryCtx } from '../src/memory/index.js';

const REPO = repoScopeRef('R_kgDOSecret01', 313131);
// Fake credentials are built from joined pieces so the file holds no whole token (the fx-runner test convention).
const TOKEN = ['Zk3?>?>Qw', '9xLm??>>', 'T5vR~?'].join(''); // gitleaks:allow
const OPAQUE_WITH_CONTROL_WORD = ['Zq8Kx', 'SPAWN_REQUEST', '9mT4pL'].join(''); // gitleaks:allow
const SIMILAR = ['Zk3?>?>Qw', '9xLm??>>', 'T5vR~!'].join(''); // gitleaks:allow

/** D#601 MEM-4a1: the four secret-scan fixes of the writers, against a real Postgres where the database is involved. */
describe('memory secret scan (D#601 MEM-4a1, section 4)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let aAdmin: string;
  let aAdmin2: string;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  const withSecrets = (userId: string, ...secrets: string[]): MemoryCtx => ({ pool: appPool, principal: { accountId: a.accountId, userId }, liveSecrets: () => secrets });
  const clean = (userId: string) => withSecrets(userId);
  const rowsHolding = async (needle: string) => (await admin.query(`SELECT id FROM memory_entries WHERE body LIKE $1 OR why LIKE $1`, [`%${needle}%`])).rowCount;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aAdmin2 = await addMember(a.accountId, 'admin');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('1. edit-then-approve of a proposal holding the live installation token is refused with secret_detected, and the token is in no row', async () => {
    const live = ['inst-', 'Xy7Qp2Lk9Vm4Nr8Tz3Wd'].join(''); // gitleaks:allow
    const p = await proposeMemory(clean(aAdmin), { scope: 'repo', scopeRef: REPO, kind: 'command', body: 'run pnpm test before pushing', authorKind: 'agent' });
    await expect(editMemory(withSecrets(aAdmin, live), { id: p.id, body: `deploy with token ${live} and then push` })).rejects.toMatchObject({ code: 'secret_detected' });
    await expect(editMemory(withSecrets(aAdmin, live), { id: p.id, body: 'fine body', why: `because ${live}` })).rejects.toMatchObject({ code: 'secret_detected' });
    // The new-proposal and write paths use the same scan, so the queue holds no other way in.
    await expect(proposeMemory(withSecrets(aAdmin, live), { scope: 'repo', scopeRef: REPO, kind: 'fact', body: `the token is ${live}` })).rejects.toMatchObject({ code: 'secret_detected' });
    expect(await rowsHolding(live)).toBe(0);
    expect((await admin.query(`SELECT 1 FROM audit_log WHERE payload::text LIKE $1`, [`%${live}%`])).rowCount).toBe(0);
    // The entry was not touched: still proposed at version 1, and approving it records the clean text.
    expect((await admin.query(`SELECT status, version FROM memory_entries WHERE id = $1`, [p.id])).rows[0]).toEqual({ status: 'proposed', version: 1 });
    expect(await decideMemory(clean(aAdmin), { id: p.id, to: 'approved' })).toMatchObject({ outcome: 'decided', entry: { status: 'approved', body: 'run pnpm test before pushing' } });
  });

  it('2. a 24-character opaque live value with SPAWN_REQUEST in its middle is refused, and so is the same value split by a control character', async () => {
    expect(OPAQUE_WITH_CONTROL_WORD).toHaveLength(24);
    const p = await proposeMemory(clean(aAdmin), { scope: 'repo', scopeRef: REPO, kind: 'fact', body: 'a clean base proposal', authorKind: 'agent' });
    const c = withSecrets(aAdmin, OPAQUE_WITH_CONTROL_WORD);
    // Cleaning would turn SPAWN_REQUEST into a marker, so a scan after cleaning alone would miss it: the raw text is scanned first.
    await expect(editMemory(c, { id: p.id, body: `use ${OPAQUE_WITH_CONTROL_WORD} here` })).rejects.toMatchObject({ code: 'secret_detected' });
    const split = `${OPAQUE_WITH_CONTROL_WORD.slice(0, 11)}\u0007${OPAQUE_WITH_CONTROL_WORD.slice(11)}`;
    await expect(editMemory(c, { id: p.id, body: `use ${split} here` })).rejects.toMatchObject({ code: 'secret_detected' });
    await expect(editMemory(c, { id: p.id, body: `use ${OPAQUE_WITH_CONTROL_WORD.slice(0, 5)}\n${OPAQUE_WITH_CONTROL_WORD.slice(5)} here` })).rejects.toMatchObject({ code: 'secret_detected' });
    expect(() => prepareMemoryText(`use ${OPAQUE_WITH_CONTROL_WORD} here`, undefined, [OPAQUE_WITH_CONTROL_WORD])).toThrow(MemoryInputError);
    expect(await rowsHolding('SPAWN_REQUEST')).toBe(0);
    expect(await rowsHolding(OPAQUE_WITH_CONTROL_WORD.slice(0, 5))).toBe(0);
    // Without the live value the same word is just cleaned, which shows the refusal above came from the scan.
    expect(prepareMemoryText(`use ${OPAQUE_WITH_CONTROL_WORD} here`).body).toContain('[removed]');
  });

  describe('3. two concurrent edits of one version', () => {
    /** The number of backends waiting on a row lock held by someone else, polled from a third connection. */
    async function waitForLockWaiter(): Promise<void> {
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%memory_edit%'`);
        if (rows.length > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the second edit never waited on the first');
    }

    it('with a barrier: the first holds the row lock, the second waits for it, and exactly one succeeds while the other gets conflict', async () => {
      const base = await proposeMemory(clean(aAdmin), { scope: 'repo', scopeRef: REPO, kind: 'fact', body: 'edit race base text', authorKind: 'agent' });
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let editedFirst!: () => void;
      const first = new Promise<void>((r) => (editedFirst = r));
      // Connection 1: edits and keeps its transaction open.
      const winner = withTenant(appPool, a.accountId, aAdmin, async (client) => {
        await client.query(`SELECT memory_edit($1::uuid, 'the winning text', NULL, NULL, NULL, NULL)`, [base.id]);
        editedFirst();
        await released;
      });
      await first;
      // Connection 2: the same edit through the core layer; it blocks on the row lock until connection 1 commits.
      const loser = editMemory(clean(aAdmin2), { id: base.id, body: 'the losing text' });
      await waitForLockWaiter();
      release();
      const [w, l] = await Promise.allSettled([winner, loser]);
      expect(w.status).toBe('fulfilled');
      expect(l.status).toBe('rejected');
      expect((l as PromiseRejectedResult).reason).toBeInstanceOf(MemoryInputError);
      expect((l as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
      const chain = (await admin.query(`SELECT version, status, body FROM memory_entries WHERE id = $1 OR supersedes_id = $1 ORDER BY version`, [base.id])).rows;
      expect(chain).toEqual([
        { version: 1, status: 'superseded', body: 'edit race base text' },
        { version: 2, status: 'proposed', body: 'the winning text' },
      ]);
    });

    it('with no barrier, repeated: whichever edit wins, the other is always conflict and the table holds one superseded row and one new version', async () => {
      for (let round = 0; round < 5; round += 1) {
        const base = await proposeMemory(clean(aAdmin), { scope: 'repo', scopeRef: REPO, kind: 'fact', body: `unbarriered base ${round} ${randomUUID()}`, authorKind: 'agent' });
        const results = await Promise.allSettled([editMemory(clean(aAdmin), { id: base.id, body: `left ${round}` }), editMemory(clean(aAdmin2), { id: base.id, body: `right ${round}` })]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
        expect(lost.reason).toMatchObject({ code: 'conflict' });
        const rows = (await admin.query(`SELECT status FROM memory_entries WHERE id = $1 OR supersedes_id = $1 ORDER BY version`, [base.id])).rows;
        expect(rows.map((r) => r.status)).toEqual(['superseded', 'proposed']);
      }
    });

    it('the one-successor index is what stops a second successor even if the function were bypassed', async () => {
      const base = await proposeMemory(clean(aAdmin), { scope: 'repo', scopeRef: REPO, kind: 'fact', body: `index arbiter ${randomUUID()}`, authorKind: 'agent' });
      await editMemory(clean(aAdmin), { id: base.id, body: `first successor ${randomUUID()}` });
      const second = `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, version, supersedes_id, content_sha256)
                      VALUES ($1, 'repo', $2, 'fact', 'second successor', 'agent', 'proposed', 2, $3, encode(sha256(convert_to('second successor','UTF8')),'hex'))`;
      await expect(admin.query(second, [a.accountId, REPO, base.id])).rejects.toMatchObject({ code: '23505', constraint: 'memory_entries_successor_idx' });
    });
  });

  describe('4. base64 of the live token inside other text', () => {
    const wrap = (lead: number, trail: string) => `${'k'.repeat(lead)}${TOKEN}${trail}`;
    const cases = [0, 1, 2].flatMap((lead) => [
      [lead, 'standard'] as const,
      [lead, 'url-safe'] as const,
    ]);

    it('builds the stable forms so that both alphabets differ for this token', () => {
      const forms = base64Forms(TOKEN);
      expect(forms).toHaveLength(6);
      expect(forms.filter((f) => /[-_]/.test(f))).toHaveLength(3);
      expect(forms.filter((f) => /[+/]/.test(f))).toHaveLength(3);
      for (const f of forms) expect(f.length).toBeGreaterThanOrEqual(18);
    });

    it.each(cases)('is refused at alignment %i, %s', (lead, alphabet) => {
      const encoded = Buffer.from(wrap(lead, ' and the end'), 'utf8').toString('base64');
      const text = alphabet === 'url-safe' ? encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encoded;
      if (alphabet === 'url-safe') expect(text).toMatch(/[-_]/);
      else expect(text).toMatch(/[+/]/);
      expect(text).not.toContain(TOKEN);
      expect(holdsLiveSecret(`notes: ${text}`, [TOKEN])).toBe(true);
      expect(() => prepareMemoryText(`notes: ${text}`, undefined, [TOKEN])).toThrow(expect.objectContaining({ code: 'secret_detected' }));
    });

    it('is refused with padding, without it, and when the encoded text sits at the very start or end of a longer one', () => {
      for (const lead of [0, 1, 2]) {
        for (const trail of ['', 'x', 'xy', 'xyz']) {
          const encoded = Buffer.from(wrap(lead, trail), 'utf8').toString('base64');
          expect(holdsLiveSecret(encoded, [TOKEN]), `${lead}/${trail}`).toBe(true);
          expect(holdsLiveSecret(encoded.replace(/=+$/, ''), [TOKEN]), `${lead}/${trail} unpadded`).toBe(true);
        }
      }
    });

    it('through the database path: an edit carrying the encoded token is refused and the encoded text is in no row', async () => {
      const p = await proposeMemory(clean(aAdmin), { scope: 'repo', scopeRef: REPO, kind: 'fact', body: 'b64 base entry', authorKind: 'agent' });
      const encoded = Buffer.from(wrap(1, ' tail'), 'utf8').toString('base64');
      await expect(editMemory(withSecrets(aAdmin, TOKEN), { id: p.id, body: `payload ${encoded}` })).rejects.toMatchObject({ code: 'secret_detected' });
      expect(await rowsHolding(encoded.slice(4, 24))).toBe(0);
    });

    it('accepts an ordinary 20-character string that only looks similar, in every encoding', () => {
      expect(SIMILAR).toHaveLength(TOKEN.length);
      expect(SIMILAR).not.toBe(TOKEN);
      for (const lead of [0, 1, 2]) {
        const text = Buffer.from(`${'k'.repeat(lead)}${SIMILAR} and the end`, 'utf8').toString('base64');
        expect(holdsLiveSecret(text, [TOKEN])).toBe(false);
      }
      const twenty = 'a1B2c3D4e5F6g7H8i9J0';
      expect(twenty).toHaveLength(20);
      for (const lead of [0, 1, 2]) {
        const text = `${Buffer.from(`${'k'.repeat(lead)}${twenty}`, 'utf8').toString('base64')} then some words`;
        expect(holdsLiveSecret(text, [TOKEN])).toBe(false);
        expect(prepareMemoryText(text, undefined, [TOKEN]).body).toContain('then some words');
      }
      expect(prepareMemoryText(`use ${twenty} for the build`, undefined, [twenty.slice(0, 15) + 'zz']).body).toContain(twenty);
    });

    it('leaves values under 16 characters alone, as before', () => {
      const short = 'abc?>?>Qw9x';
      expect(holdsLiveSecret(Buffer.from(`k${short}`, 'utf8').toString('base64'), [short])).toBe(false);
    });
  });
});
