import type { PoolClient } from "pg";
import { DiscussionsError } from "./operations.js";

/**
 * Conventions: "Constants live in one file, packages/discussions/src/
 * limits.ts." Only MAX_BODY_BYTES, MAX_COMMENTS_PER_RUN,
 * MAX_RUN_COMMENT_BYTES and STORAGE_QUOTA_BYTES are enforced by this PR
 * (create, comment, revise); the mirror/inbound/public-read constants are
 * declared here (the one file the whole epic's constants live in) for
 * DS-6/DS-7/DS-10 to read later. Storage quota figures are the DS-11 cost
 * study's confirmed 1/5/20 GiB (correction C6: "this ruling does not
 * revisit it").
 */
export const MAX_BODY_BYTES = 65_536;
export const MAX_COMMENTS_PER_RUN = 20;
export const MAX_RUN_COMMENT_BYTES = 262_144;

export type PlanId = "starter" | "team" | "scale";

const GIB = 1024 ** 3;

/** Total UTF-8 bytes of Discussion content a tenant may have stored
 * (`discussion_counters.bytes_used`) -- an abuse ceiling, not a capacity
 * plan (DS-11 section 5); nothing in this epic grants extra quota or
 * writes a credit when it's reached. */
export const STORAGE_QUOTA_BYTES: Readonly<Record<PlanId, number>> = Object.freeze({
  starter: 1 * GIB,
  team: 5 * GIB,
  scale: 20 * GIB,
});

/** DS-6 outbound mirror token bucket (read by DS-6, not this PR). */
export const MIRROR_WRITES_PER_MINUTE = 60;
export const MIRROR_WRITES_PER_HOUR = 450;
/** DS-6: max age of a cached repo-visibility read (read by DS-6, not this PR). */
export const MIRROR_VISIBILITY_MAX_AGE_S = 60;
/** DS-7 inbound webhook rate limit (read by DS-7, not this PR). */
export const INBOUND_MAX_PER_REPO_PER_MINUTE = 60;
/** DS-10 public read rate limit (read by DS-10, not this PR). */
export const PUBLIC_READ_PER_IP_PER_MINUTE = 60;

/** Criterion 10: a comment, revision, Spec or correction body over
 * MAX_BODY_BYTES UTF-8 bytes is refused with `payload_too_large` before
 * any query, so no row is ever written. */
export function requireBodyWithinLimit(body: unknown): string {
  if (typeof body !== "string") {
    throw new DiscussionsError("invalid_input", "body must be a string");
  }
  // Postgres text cannot hold NUL; left alone it surfaces as a 500 at INSERT.
  if (body.includes("\u0000")) {
    throw new DiscussionsError("invalid_input", "body must not contain a NUL byte");
  }
  const bytes = utf8ByteLength(body);
  if (bytes > MAX_BODY_BYTES) {
    throw new DiscussionsError(
      "payload_too_large",
      `body is ${bytes} UTF-8 bytes, over the ${MAX_BODY_BYTES}-byte limit`,
    );
  }
  return body;
}

/** UTF-8 byte length of a string -- the unit every byte-based limit above
 * (and `discussion_counters.bytes_used`) is measured in. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Ensures a `discussion_counters` row exists, then locks it (`FOR
 * UPDATE`, serializing concurrent writers for the same account) and
 * checks `addedBytes` against the account's plan quota -- criterion 11.
 * `plan` is read from `accounts` inside this same client/transaction,
 * never accepted as caller input. Throws `storage_quota_exceeded` and
 * touches no other row when the write would exceed it; otherwise returns
 * the locked `bytes_used` for the caller's own UPDATE. */
async function reserveOrThrow(client: PoolClient, accountId: string, addedBytes: number): Promise<void> {
  const { rows: planRows } = await client.query<{ plan: string }>(`SELECT plan FROM accounts WHERE id = $1`, [
    accountId,
  ]);
  const plan = (planRows[0]?.plan ?? "starter") as PlanId;
  const quota = STORAGE_QUOTA_BYTES[plan] ?? STORAGE_QUOTA_BYTES.starter;

  await client.query(`INSERT INTO discussion_counters (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [
    accountId,
  ]);
  const { rows } = await client.query<{ bytes_used: string }>(
    `SELECT bytes_used FROM discussion_counters WHERE account_id = $1 FOR UPDATE`,
    [accountId],
  );
  if (BigInt(rows[0]!.bytes_used) + BigInt(addedBytes) > BigInt(quota)) {
    throw new DiscussionsError(
      "storage_quota_exceeded",
      `writing ${addedBytes} bytes would take this account's Discussion storage over its ${plan} plan quota of ${quota} bytes`,
    );
  }
}

/** Criterion 11: charges `addedBytes` against the account's storage
 * quota, in the same transaction as the write it's charging for. */
export async function chargeStorage(client: PoolClient, accountId: string, addedBytes: number): Promise<void> {
  await reserveOrThrow(client, accountId, addedBytes);
  await client.query(`UPDATE discussion_counters SET bytes_used = bytes_used + $2 WHERE account_id = $1`, [
    accountId,
    addedBytes,
  ]);
}

/** Criterion 16: allocates the next `discussions.number` for `accountId`
 * and charges `addedBytes` in the same UPDATE, so 50 concurrent
 * `discussion.create` calls serialize on the one locked
 * `discussion_counters` row and come out as 1..50 with no gap or
 * duplicate. */
export async function allocateDiscussionNumber(
  client: PoolClient,
  accountId: string,
  addedBytes: number,
): Promise<number> {
  await reserveOrThrow(client, accountId, addedBytes);
  const { rows } = await client.query<{ number: string }>(
    `UPDATE discussion_counters
       SET next_number = next_number + 1, bytes_used = bytes_used + $2
     WHERE account_id = $1
     RETURNING next_number - 1 AS number`,
    [accountId, addedBytes],
  );
  return Number(rows[0]!.number);
}
