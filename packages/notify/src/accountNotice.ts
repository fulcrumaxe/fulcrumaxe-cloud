import type { PoolClient } from "pg";

/**
 * Posts an Inbox notice to the owners and admins of the session's account (migration 1062, `account_notice_post`). The caller passes a client that is
 * already inside the account's tenant transaction (withTenant), so the notice commits or rolls back with whatever the caller was doing. A notice is a kind
 * (`area.what`, lower case) and one id, never text: nothing a person typed, no name and no address can travel in it. Answers how many people it reached.
 */
export async function postAccountNotice(client: Pick<PoolClient, "query">, kind: string, ref: string | null = null): Promise<number> {
  const { rows } = await client.query<{ n: number }>("SELECT account_notice_post($1::text, $2::uuid) AS n", [kind, ref]);
  return rows[0]?.n ?? 0;
}
