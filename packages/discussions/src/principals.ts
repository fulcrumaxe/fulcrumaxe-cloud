/**
 * Conventions: four principal kinds -- session (signed-in human), token (a
 * D#31 API-3b token, acting as its minting member), run (a hosted agent
 * run, only from D#47's verified run token inside M04's door) and system
 * (server code only, via systemPrincipal, never from the package index).
 *
 * SECURITY: "role and agent_run_id [are] taken from agent_runs, never from
 * text." D#47's door doesn't exist yet, so `run` carries ONLY `accountId`
 * and `runId` here -- never a client-suppliable `role`/`workItemId`. Every
 * function accepting a `run` principal re-derives `role`/`work_item_id`
 * from a fresh, tenant-scoped `SELECT ... FROM agent_runs` inside its own
 * transaction, never from the principal object. RLS confines that SELECT
 * to the run's own tenant, so a foreign or missing `runId` reads back zero
 * rows -> `NotFoundError`, never a cross-tenant leak -- and DS-2 needs no
 * D#47 integration to be testable: a [pg] test seeds `agent_runs` directly.
 */

import type { Pool } from "pg";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { redactShapes } from "@fx/runtime/src/redact.js";

export type MembershipRole = "owner" | "admin" | "member";

export type TokenScope = "read" | "write";

export type Principal =
  | { kind: "session"; accountId: string; userId: string; role: MembershipRole }
  | { kind: "token"; accountId: string; userId: string; tokenId: string; scopes: readonly TokenScope[] }
  | { kind: "run"; accountId: string; runId: string }
  | { kind: "system"; accountId: string; reason: string };

/** Reads `key` only if it is an OWN DATA property of the principal. An
 * inherited value (Object.prototype pollution), an accessor (never invoked)
 * or a missing key reads as `undefined`, which every caller treats as deny. */
export function ownField(principal: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(principal, key);
  return d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined;
}

/** The principal's `kind`, read as an own data property only. */
export function kindOf(principal: Principal): unknown {
  return ownField(principal, "kind");
}

function requireOwnString(principal: Principal, key: string): string {
  const v = ownField(principal, key);
  if (typeof v !== "string" || v === "") {
    throw new ForbiddenError(`principal has no own ${key}`);
  }
  return v;
}

/** The tenant a principal acts in. An inherited or missing value throws
 * ForbiddenError before any query, so it can never reach withTenant. */
export function accountIdOf(principal: Principal): string {
  return requireOwnString(principal, "accountId");
}

/** A run principal's run id, own data property only (else ForbiddenError). */
export function runIdOf(principal: Principal): string {
  return requireOwnString(principal, "runId");
}

/** "Human-only means a session principal whose role is owner or admin." */
export function isHumanOnly(principal: Principal): boolean {
  if (ownField(principal, "kind") !== "session") return false;
  const role = ownField(principal, "role");
  return role === "owner" || role === "admin";
}

export function hasScope(principal: Principal, scope: TokenScope): boolean {
  if (ownField(principal, "kind") !== "token") return false;
  const scopes = ownField(principal, "scopes");
  return Array.isArray(scopes) && scopes.includes(scope);
}

/** Conventions: "Every service call takes (ctx: {pool, principal}, input)
 * and runs under withTenant(principal.accountId)." */
export interface DiscussionsContext {
  pool: Pool;
  principal: Principal;
}

/** The `users.id` a principal acts as, for "own row" checks -- session and
 * token principals both act as a member (a token "acts as the member who
 * minted it"); run and system principals act as no user at all. */
export function actingUserId(principal: Principal): string | null {
  const kind = kindOf(principal);
  if (kind === "session" || kind === "token") {
    return requireOwnString(principal, "userId");
  }
  return null;
}

/** Criterion 12: "Any body written by a run or system principal passes
 * through redactShapes (packages/runtime/src/redact.ts:89) before
 * insert. A fake sk-ant-api03-... key in the input is absent from the
 * stored row." Session and token principals are humans (or acting as
 * one) typing directly -- nothing here redacts their own text. */
export function redactIfNeeded(principal: Principal, body: string): string {
  const kind = kindOf(principal);
  return kind === "run" || kind === "system" ? redactShapes(body) : body;
}

/** `created_by_kind`/`author_kind` plus the acting user id, for the three
 * principal kinds allowed to create or revise a discussion (`run` is
 * denied for both operations by the table, so it never reaches this). */
export function actorForWrite(principal: Principal): { kind: "user" | "system"; userId: string | null } {
  if (kindOf(principal) === "system") {
    return { kind: "system", userId: null };
  }
  return { kind: "user", userId: actingUserId(principal) };
}
