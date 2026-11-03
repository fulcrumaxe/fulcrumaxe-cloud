import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { planData, startWorld, usePlanData, type Person } from './helpers/assistantWorld.js';

/**
 * D#597 CC-5e (R-597-C2-2): the messages route is session only. A delegation token and every ordinary token are refused the same way on the
 * JSON form and on the event stream, before any conversation or model call, and nothing of the assistant is reachable by a token.
 */
describe('assistant messages: session only', () => {
  const saved = process.env.FX_PLAN_DATA;
  let w: Awaited<ReturnType<typeof startWorld>>;
  let p: Person;
  const tokens: Record<string, string> = {};
  const body = (repoId: string) => ({ repo_id: repoId, messages: [{ role: 'user', content: 'hello' }] });
  const mint = async (scopes: Array<'read' | 'corrections:write' | 'work_items:write'>, delegation?: { repoId: string; clientId: string }) => {
    const plaintext = generateToken();
    await insertApiToken(w.app, {
      accountId: p.accountId, createdBy: p.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes,
      expiresAt: new Date(Date.now() + 3_000_000), ...(delegation ? { delegation } : {}),
    });
    return plaintext;
  };

  beforeAll(async () => {
    w = await startWorld();
    usePlanData(planData({ cap: 2 }));
    p = await w.person();
    tokens.delegation = await mint(['read', 'corrections:write'], { repoId: p.repoId, clientId: 'probe' });
    tokens.read = await mint(['read']);
    tokens.write = await mint(['read', 'work_items:write', 'corrections:write']);
  });
  afterEach(() => w.reset());
  afterAll(async () => {
    usePlanData(saved === undefined ? undefined : JSON.parse(saved));
    await w.stop();
  });

  it('CC-5-6: a delegation token and ordinary tokens get 403 session_required on the JSON form and the stream; no conversation, no model call', async () => {
    for (const [name, bearer] of Object.entries(tokens)) {
      for (const stream of [false, true]) {
        const r = await w.send({ bearer }, body(p.repoId), { stream });
        expect(r.status, `${name} stream=${stream}`).toBe(403);
        expect(r.contentType).toContain('application/json');
        expect(r.json().error.code, `${name} stream=${stream}`).toBe('session_required');
      }
    }
    expect(w.calls()).toBe(0);
    expect((await w.admin.query(`SELECT count(*)::int AS n FROM assistant_conversations WHERE account_id = $1`, [p.accountId])).rows[0].n).toBe(0);
  });

  it('no credential is 401 on both forms, and the registry entry is the default (session) principal with no token class', () => {
    const entry = ROUTES.find((r) => r.path === '/api/v1/assistant/messages')!;
    expect(effectivePrincipals(entry)).toEqual(['session']);
    expect(entry.tokens).toBeUndefined();
    expect(entry.scope).toBeUndefined();
    expect(entry.startsRun).toBeFalsy();
  });

  it('an unauthenticated request is 401 on both forms', async () => {
    for (const stream of [false, true]) expect((await w.send({}, body(p.repoId), { stream })).status).toBe(401);
    expect(w.calls()).toBe(0);
  });
});
