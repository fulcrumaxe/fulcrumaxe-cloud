import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { decodeCursor } from '../src/pagination.js';
import { TOKEN_FORMAT_RE, displayHint, verifyChecksum } from '../src/tokens/format.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

interface Identity {
  accountId: string;
  userId: string;
}

interface ListItem {
  id: string;
  name: string | null;
  created_by: string;
  created_by_me: boolean;
}

/** D#31 API-3g (C20): the optional, immutable, validated token name and the server-computed created_by_me flag. Every refusal is proven live through the real handler. */
describe('D#31 API-3g: token name and created_by_me', () => {
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

  async function dispatch(url: string, identity: Identity, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    return handleApiRequest(new Request(url, { ...init, headers }), appUserPool, platformOpsPool, ROUTES);
  }

  function createToken(identity: Identity, body: Record<string, unknown>): Promise<Response> {
    return dispatch('http://localhost/api/v1/tokens', identity, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function listTokens(identity: Identity): Promise<{ status: number; text: string; items: ListItem[] }> {
    const res = await dispatch('http://localhost/api/v1/tokens', identity);
    const text = await res.text();
    return { status: res.status, text, items: (JSON.parse(text) as { data: ListItem[] }).data };
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [
      accountId,
      userId,
      role,
    ]);
    return { accountId, userId };
  }

  const cp = (n: number, ch = 'a') => ch.repeat(n);

  describe('criteria 3-5: accepted names are stored and returned byte for byte', () => {
    it('an omitted name and an explicit null are both stored as NULL and returned as null on create and list', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const omitted = await createToken(id, { scopes: ['read'] });
      expect(omitted.status).toBe(201);
      expect(((await omitted.json()) as { name: unknown }).name).toBeNull();
      const explicitNull = await createToken(id, { scopes: ['read'], name: null });
      expect(explicitNull.status).toBe(201);
      expect(((await explicitNull.json()) as { name: unknown }).name).toBeNull();

      const { items } = await listTokens(id);
      expect(items).toHaveLength(2);
      expect(items.every((t) => t.name === null)).toBe(true);
      const { rows } = await admin.query('SELECT name FROM api_tokens WHERE account_id = $1', [id.accountId]);
      expect(rows.every((r) => r.name === null)).toBe(true);
    });

    it('a 64-code-point name with spaces, an accent, CJK and an emoji round-trips unchanged; the DB holds the same bytes', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const name = 'CI bot é 漢字 😀' + 'x'.repeat(64 - [...'CI bot é 漢字 😀'].length);
      expect([...name]).toHaveLength(64);
      expect(name.length).toBeGreaterThan(64); // the emoji is two UTF-16 units: code points, not units, are counted.
      const res = await createToken(id, { scopes: ['read'], name });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; name: string };
      expect(created.name).toBe(name);
      const { items } = await listTokens(id);
      expect(items.find((t) => t.id === created.id)?.name).toBe(name);
      const { rows } = await admin.query<{ name: string }>('SELECT name FROM api_tokens WHERE id = $1', [created.id]);
      expect(Buffer.from(rows[0]!.name, 'utf8').equals(Buffer.from(name, 'utf8'))).toBe(true);
    });

    it('exactly 64 code points is accepted (64 emoji, 128 UTF-16 units) and 65 is refused', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      expect((await createToken(id, { scopes: ['read'], name: cp(64, '😀') })).status).toBe(201);
      expect((await createToken(id, { scopes: ['read'], name: cp(64) })).status).toBe(201);
      expect((await createToken(id, { scopes: ['read'], name: cp(65) })).status).toBe(422);
      expect((await createToken(id, { scopes: ['read'], name: cp(65, '😀') })).status).toBe(422);
    });

    it('a single-code-point name, internal spaces and punctuation are accepted', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      for (const name of ['a', 'my token: prod (v2) - #1', 'déjà vu', '日本語のトークン']) {
        const res = await createToken(id, { scopes: ['read'], name });
        expect(res.status).toBe(201);
        expect(((await res.json()) as { name: string }).name).toBe(name);
      }
    });
  });

  describe('criterion 3: refusals -> 422 pointing at name, never echoing the value, storing nothing', () => {
    const MARK = 'ZQXMARKER';
    const refused: [string, unknown][] = [
      ['the empty string', ''],
      ['65 ASCII code points', cp(65)],
      ['65 emoji', cp(65, '😀')],
      ['leading space', ` ${MARK}`],
      ['trailing space', `${MARK} `],
      ['leading tab', `\t${MARK}`],
      ['trailing newline', `${MARK}\n`],
      ['leading NBSP', ` ${MARK}`],
      ['trailing ideographic space', `${MARK}　`],
      ['an all-whitespace name', '   '],
      ['embedded NUL', `${MARK}\u0000x`],
      ['embedded C0 control (U+0001)', `${MARK}\u0001x`],
      ['embedded TAB', `${MARK}\tx`],
      ['embedded newline', `${MARK}\nx`],
      ['embedded ESC', `${MARK}\u001bx`],
      ['embedded DEL', `${MARK}\u007fx`],
      ['embedded C1 control (U+0080)', `${MARK}\u0080x`],
      ['embedded C1 NEL (U+0085)', `${MARK}\u0085x`],
      ['embedded C1 control (U+009F)', `${MARK}\u009fx`],
      ['bidi embedding LRE (U+202A)', `${MARK}‪x`],
      ['bidi override RLO (U+202E)', `${MARK}‮x`],
      ['bidi isolate LRI (U+2066)', `${MARK}⁦x`],
      ['bidi isolate PDI (U+2069)', `${MARK}⁩x`],
      ['U+2028 line separator', `${MARK} x`],
      ['U+2029 paragraph separator', `${MARK} x`],
      ['a number', 12345],
      ['an array', [MARK]],
      ['an object', { [MARK]: MARK }],
      ['a boolean', true],
    ];

    for (const [label, value] of refused) {
      it(`${label} -> 422, details path is name, the value is not echoed, no row is stored`, async () => {
        const id = await seedAccountWithMember(admin, { role: 'owner' });
        const res = await createToken(id, { scopes: ['read'], name: value });
        const text = await res.text();
        expect(res.status).toBe(422);
        const body = JSON.parse(text) as { error: { code: string }; details?: { path: string }[] };
        expect(body.error.code).toBe('validation_failed');
        expect(body.details?.some((d) => d.path === 'name')).toBe(true);
        expect(text).not.toContain(MARK);
        if (typeof value === 'string' && value.trim() !== '' && value.length > 0) {
          expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
        }
        const { rows } = await admin.query('SELECT 1 FROM api_tokens WHERE account_id = $1', [id.accountId]);
        expect(rows).toHaveLength(0);
      });
    }

    it('a lone UTF-16 surrogate (which Postgres cannot store byte for byte) -> 422', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const res = await dispatch('http://localhost/api/v1/tokens', id, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"scopes":["read"],"name":"ab\\ud800cd"}',
      });
      expect(res.status).toBe(422);
      const { rows } = await admin.query('SELECT 1 FROM api_tokens WHERE account_id = $1', [id.accountId]);
      expect(rows).toHaveLength(0);
    });

    it('a refused name is not trimmed into acceptance: " x" is a 422, not a stored "x"', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      expect((await createToken(id, { scopes: ['read'], name: ' x' })).status).toBe(422);
      expect((await createToken(id, { scopes: ['read'], name: 'x ' })).status).toBe(422);
      expect((await listTokens(id)).items).toHaveLength(0);
    });
  });

  describe('criterion 6: created_by_me', () => {
    it('an owner listing their own token and a member\'s token sees true on their own row and false on the member\'s', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const member = await addMember(owner.accountId, 'member');
      const ownId = ((await (await createToken(owner, { scopes: ['read'], name: 'owner tok' })).json()) as { id: string }).id;
      const memberId = ((await (await createToken(member, { scopes: ['read'], name: 'member tok' })).json()) as { id: string }).id;

      const { items } = await listTokens(owner);
      const own = items.find((t) => t.id === ownId)!;
      const theirs = items.find((t) => t.id === memberId)!;
      expect(own.created_by_me).toBe(true);
      expect(own.created_by).toBe(owner.userId);
      expect(theirs.created_by_me).toBe(false);
      expect(theirs.created_by).toBe(member.userId);
    });

    it('a member sees true on every row they can see (RLS limits them to their own)', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const member = await addMember(owner.accountId, 'member');
      await createToken(owner, { scopes: ['read'] });
      await createToken(member, { scopes: ['read'] });
      await createToken(member, { scopes: ['read'], name: 'x' });
      const { items } = await listTokens(member);
      expect(items).toHaveLength(2);
      expect(items.every((t) => t.created_by_me === true)).toBe(true);
    });

    it('created_by_me is not a column and the create response carries no such field', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const created = (await (await createToken(id, { scopes: ['read'] })).json()) as Record<string, unknown>;
      expect(created).not.toHaveProperty('created_by_me');
      const { rows } = await admin.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'api_tokens' AND column_name = 'created_by_me'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('criterion 7: the name plays no part in authentication, scopes or revocation', () => {
    it('two tokens with the same name both authenticate; revoking one by id leaves the other working', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const mint = async () =>
        (await (await createToken(id, { scopes: ['read'], name: 'shared name' })).json()) as { id: string; token: string };
      const a = await mint();
      const b = await mint();
      expect(a.id).not.toBe(b.id);
      const readAs = (plaintext: string) =>
        handleApiRequest(
          new Request('http://localhost/api/v1/account', {
            headers: {
              authorization: `Bearer ${plaintext}`,
              'x-forwarded-for': `198.51.${randomInt(0, 255)}.${randomInt(1, 255)}`,
            },
          }),
          appUserPool,
          platformOpsPool,
          ROUTES,
        );
      expect((await readAs(a.token)).status).toBe(200);
      expect((await readAs(b.token)).status).toBe(200);

      const del = await dispatch(`http://localhost/api/v1/tokens/${a.id}`, id, { method: 'DELETE' });
      expect(del.status).toBe(204);
      expect((await readAs(a.token)).status).toBe(401);
      expect((await readAs(b.token)).status).toBe(200);
      const { items } = await listTokens(id);
      expect(items.map((t) => t.name)).toEqual(['shared name', 'shared name']);
    });
  });

  describe('criterion 8: no cross-tenant or cross-member leak', () => {
    it("tenant B's owner list contains neither A's token id nor A's name", async () => {
      const a = await seedAccountWithMember(admin, { role: 'owner' });
      const b = await seedAccountWithMember(admin, { role: 'owner' });
      const name = `tenant-a-secret-${randomUUID()}`;
      const created = (await (await createToken(a, { scopes: ['read'], name })).json()) as { id: string };
      await createToken(b, { scopes: ['read'], name: 'b tok' });

      const { text, items } = await listTokens(b);
      expect(items).toHaveLength(1);
      expect(text).not.toContain(created.id);
      expect(text).not.toContain(name);

      // The name is no handle on A's token: B cannot revoke it by id either.
      const del = await dispatch(`http://localhost/api/v1/tokens/${created.id}`, b, { method: 'DELETE' });
      expect(del.status).toBe(404);
      expect(await del.text()).not.toContain(name);
    });

    it("within one account, member M2's list does not contain member M1's token name", async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const m1 = await addMember(owner.accountId, 'member');
      const m2 = await addMember(owner.accountId, 'member');
      const name = `m1-private-${randomUUID()}`;
      const created = (await (await createToken(m1, { scopes: ['read'], name })).json()) as { id: string };
      await createToken(m2, { scopes: ['read'], name: 'm2 tok' });

      const { text, items } = await listTokens(m2);
      expect(items).toHaveLength(1);
      expect(text).not.toContain(name);
      expect(text).not.toContain(created.id);
    });
  });

  describe('criterion 9: where the name does not go', () => {
    it('the api_token.created audit payload keeps its exact key set and never carries the name', async () => {
      const id = await seedAccountWithMember(admin, { role: 'owner' });
      const name = `audit-probe-${randomUUID()}`;
      const created = (await (await createToken(id, { scopes: ['read'], name })).json()) as { id: string };
      await dispatch(`http://localhost/api/v1/tokens/${created.id}`, id, { method: 'DELETE' });
      const { rows } = await admin.query<{ action: string; payload: Record<string, unknown> }>(
        `SELECT action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'api_token.%'`,
        [id.accountId],
      );
      const createdRow = rows.find((r) => r.action === 'api_token.created')!;
      expect(Object.keys(createdRow.payload).sort()).toEqual(['expires_at', 'scopes', 'token_id']);
      expect(JSON.stringify(rows)).not.toContain(name);
      // No other table that could carry it: webhook deliveries, run events.
      for (const table of ['webhook_deliveries', 'run_events']) {
        const { rows: hits } = await admin.query(`SELECT 1 FROM ${table} t WHERE t::text LIKE $1`, [`%${name}%`]);
        expect(hits).toHaveLength(0);
      }
    });
  });
});

/** The token fixtures must look like what the real API emits, so a client generated from them does not learn a shape the server never produces. */
describe('D#31 API-3g: token fixtures match the real formats', () => {
  const fixture = (rel: string) => JSON.parse(readFileSync(path.join(TEST_DIR, '..', 'fixtures', 'v1', rel), 'utf8'));

  it('createToken fixtures carry a real-format token whose checksum verifies and whose display_hint is displayHint()', () => {
    for (const file of ['201-created.json', '201-created-named.json']) {
      const body = fixture(`createToken/${file}`) as { token: string; display_hint: string };
      expect(body.token, file).toMatch(TOKEN_FORMAT_RE);
      expect(verifyChecksum(body.token), file).toBe(true);
      expect(body.display_hint, file).toBe(displayHint(body.token));
    }
  });

  it('listTokens fixture hints have the real shape and next_cursor encodes the last row of the page', () => {
    const page = fixture('listTokens/200-page.json') as {
      data: { id: string; display_hint: string; created_at: string }[];
      next_cursor: string;
    };
    for (const row of page.data) {
      expect(row.display_hint).toMatch(/^fxat_\.\.\.[0-9A-Za-z]{4}$/);
    }
    const last = page.data[page.data.length - 1]!;
    // The service reads created_at for the cursor via to_char(...US): microsecond precision.
    expect(decodeCursor(page.next_cursor)).toEqual({
      created_at: last.created_at.replace(/\.(\d{3})Z$/, '.$1000Z'),
      id: last.id,
    });
  });
});
