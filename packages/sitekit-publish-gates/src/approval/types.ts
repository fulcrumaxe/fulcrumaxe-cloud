import type { Blocker } from "../../../sitekit-claims/src/index.js";
import type { Finding } from "../types.js";

/** The slice of a pg client the approval library needs. Run it inside one withTenant transaction. */
export interface ApprovalDb {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Who is acting. Deliberately no `role`: the role is always re-read from
 * account_members, so a stale or forged role on the caller's object grants
 * nothing. `accountId`/`userId` must match the transaction's own
 * app.account_id/app.user_id (withTenant's 4-arg form) or every call is refused.
 */
export interface Principal {
  accountId: string;
  userId: string;
}

/** A typed refusal. K07b maps every one of these to 409 (forbidden to 403, not_found to 404). */
export type Refusal =
  | { code: "forbidden" }
  | { code: "not_found" }
  | { code: "claim_not_in_site" }
  | { code: "not_attestable"; kind: string }
  | { code: "already_approved" }
  | { code: "terms_not_accepted" }
  | { code: "unattested_claim"; claimIds: string[]; blockers: Blocker[] }
  | { code: "blocked"; blockers: Blocker[] }
  | { code: "render_failed"; detail: string }
  | { code: "leak"; findings: Finding[] }
  | { code: "unapproved_link"; links: string[]; findings: Finding[] }
  /** One entry per failing site check. Findings are attacker-controlled text: data only, never put in a message. */
  | { code: "check_failed"; checks: { check: string; findings: Finding[] }[] };

export type Outcome<T> = ({ ok: true } & T) | { ok: false; refusal: Refusal };
export const refuse = (refusal: Refusal): { ok: false; refusal: Refusal } => ({ ok: false, refusal });
