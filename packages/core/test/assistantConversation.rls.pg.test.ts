import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../src/tenancy/errors.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { accountAssistantSpend, admitTurn, getConversation, settleTurn, startConversation } from '../src/assistant/conversations.js';
import { planDataWith, restorePlanData, usePlanData } from './assistantConversation.support.js';

/** D#597 CC-5c: who can read or charge a conversation, and what app_user may do to the table. */
describe('assistant conversation access (D#597 CC-5c)', () => {
  const saved = process.env.FX_PLAN_DATA;
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let owner: string;
  let m1: string;
  let m2: string;
  let userB: string;
  let conv: string;
  const as = (accountId: string, userId: string) => ({ pool: appPool, principal: { accountId, userId } });

  async function addMember(accountId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    usePlanData(planDataWith(2));
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    owner = await addMember(a.accountId, 'owner');
    m1 = await addMember(a.accountId, 'member');
    m2 = await addMember(a.accountId, 'member');
    userB = await addMember(b.accountId, 'member');
    conv = (await startConversation(as(a.accountId, m1), { repoId: a.repoId })).id;
  });
  afterEach(() => usePlanData(planDataWith(2)));
  afterAll(async () => {
    restorePlanData(saved);
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('the creator and an owner read it; another member and another account get nothing', async () => {
    expect((await getConversation(as(a.accountId, m1), conv)).id).toBe(conv);
    expect((await getConversation(as(a.accountId, owner), conv)).id).toBe(conv);
    await expect(getConversation(as(a.accountId, m2), conv)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getConversation(as(b.accountId, userB), conv)).rejects.toBeInstanceOf(NotFoundError);
    expect(await accountAssistantSpend(as(a.accountId, m2))).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 0, conversations: 0 });
    expect((await accountAssistantSpend(as(a.accountId, owner))).conversations).toBe(1);
  });

  it("account B cannot charge or settle account A's conversation, nor can another member or an owner; nothing moves", async () => {
    const t = { conversationId: conv, model: 'sonnet-5', inputTokensEstimate: 10, maxOutputTokens: 10 };
    for (const ctx of [as(b.accountId, userB), as(a.accountId, m2), as(a.accountId, owner)]) {
      await expect(admitTurn(ctx, t)).rejects.toBeInstanceOf(NotFoundError);
      await expect(settleTurn(ctx, { conversationId: conv, holdId: randomUUID(), model: 'sonnet-5', usage: null })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await getConversation(as(a.accountId, m1), conv)).toMatchObject({ spentMicroUsd: 0, reservedMicroUsd: 0, turns: 0 });
  });

  it('a user who is not a member of the account cannot start or charge', async () => {
    const stranger = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [stranger, `${stranger}@example.test`]);
    await expect(startConversation(as(a.accountId, stranger), { repoId: a.repoId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(admitTurn(as(a.accountId, stranger), { conversationId: conv, model: 'sonnet-5', inputTokensEstimate: 1, maxOutputTokens: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a conversation on another account's repo is refused", async () => {
    await expect(startConversation(as(a.accountId, m1), { repoId: b.repoId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('app_user has no UPDATE or DELETE; the CHECKs (no negative spent or held) hold even for the admin connection', async () => {
    await withTenant(appPool, a.accountId, m1, async (client) => {
      await client.query('SAVEPOINT s1');
      await expect(client.query(`UPDATE assistant_conversations SET spent_micro_usd = 1 WHERE id = $1`, [conv])).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(client.query(`DELETE FROM assistant_conversations WHERE id = $1`, [conv])).rejects.toMatchObject({ code: '42501' });
    });
    await expect(admin.query(`UPDATE assistant_conversations SET reserved_micro_usd = -1 WHERE id = $1`, [conv])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE assistant_conversations SET spent_micro_usd = -1 WHERE id = $1`, [conv])).rejects.toMatchObject({ code: '23514' });
  });

  it('an insert cannot name another creator or start with spend', async () => {
    await withTenant(appPool, a.accountId, m1, async (client) => {
      await client.query('SAVEPOINT s1');
      await expect(
        client.query(`INSERT INTO assistant_conversations (account_id, repo_id, created_by, cap_micro_usd) VALUES ($1, $2, $3, 1)`, [a.accountId, a.repoId, m2]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(
        client.query(`INSERT INTO assistant_conversations (account_id, repo_id, created_by, cap_micro_usd, spent_micro_usd) VALUES ($1, $2, $3, 5, 5)`, [a.accountId, a.repoId, m1]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
