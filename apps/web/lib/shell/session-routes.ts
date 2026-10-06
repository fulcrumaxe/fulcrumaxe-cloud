import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import type { VerifiedSession } from "@fx/core/src/auth/session";
import { getUserProfile } from "@fx/core/src/auth/identity";
import { getMemberRole } from "@fx/core/src/tenancy/authorize";
import { withTenant } from "@fx/core/src/tenancy/withTenant";
import { listPlans, readAccountStatus, type AccountStatus, type Plan } from "@fx/billing";
import { PlanDataMissingError } from "@fx/plan-data";
import { applyNoStore, applySecurityHeaders } from "./headers";
import { opaqueUserId, storageNamespace } from "./storage-ns";
import { SHELL_PATH_HEADER, resourceForShellPath, type ShellSessionResource } from "./shell-paths";
import { applyRefreshedSessionCookie, resolveActiveSession, type SessionGuardOptions } from "./session-guard";

export interface SessionRouteDeps {
  platformOpsPool: Pool;
  appUserPool: Pool;
}

/** criterion 3 (`auth/me`/`profile`) and criterion 4 (`entitlements`, `license`, `preferences`): "without a session -> 401, empty body." A `Response`/`NextResponse` body of `null` sends no body at all -- not even `{}` or `""` -- which is what "empty body" means literally. */
function empty401(): NextResponse {
  return applySecurityHeaders(applyNoStore(new NextResponse(null, { status: 401 })));
}

/** D#37 WS-L1 (correction C19c criterion 5): what `auth/me`'s new `workspace_access` field can be. */
export type WorkspaceAccess = "open" | "no_subscription" | "subscription_ended";

/**
 * D#37 WS-L1 (correction C19c criterion 5): derives `workspace_access`
 * from D#69's `accounts.status` (#93, merged). Fail closed -- `null`
 * (no row / no read access) and any value not in the table below map to
 * `no_subscription`, never `open`:
 *
 *   active, past_due, paused, model_key_broken -> open
 *   unsubscribed                               -> no_subscription
 *   cancelled                                  -> subscription_ended
 *   anything else, or none                     -> no_subscription
 */
export function deriveWorkspaceAccess(status: AccountStatus | null): WorkspaceAccess {
  switch (status) {
    case "active":
    case "past_due":
    case "paused":
    case "model_key_broken":
      return "open";
    case "cancelled":
      return "subscription_ended";
    case "unsubscribed":
    default:
      return "no_subscription";
  }
}

/**
 * D#37 WS-L1 (correction C19c criterion 5): reads the session's OWN
 * account status through billing's public, authorized C7 read surface
 * (`readAccountStatus`) -- never a raw query against `accounts` from
 * this module. `ctx.pool` is the platform_ops pool: billing's own
 * `BillingCtx` doc comment explains why platform_ops's unconditional
 * `account_members` grant lets `readAccountStatus`'s own membership
 * check (`authorizeAccountRead`) resolve correctly against this same
 * pool, with no second pool to carry. Criterion 7: "workspace_access is
 * derived only from the session's own account" -- `principal.accountId`
 * and `input.accountId` are both `session.accountId`, never a caller-
 * supplied value.
 */
async function workspaceAccessForSession(session: VerifiedSession, deps: SessionRouteDeps): Promise<WorkspaceAccess> {
  const status = await readAccountStatus(
    { pool: deps.platformOpsPool, principal: { accountId: session.accountId, userId: session.userId } },
    { accountId: session.accountId },
  );
  return deriveWorkspaceAccess(status);
}

/**
 * D#37 WS-C criterion 3: "With a session -> only `username` (GitHub
 * login), `email` (display), `is_admin` (cosmetic), an opaque `id`
 * (never a DB id and never `1`) and `storage_ns`." (Correction C8:
 * `username` is required in this PR -- `getUserProfile`, identity.ts,
 * provider.ts and both OAuth callback handlers now capture and store
 * the GitHub login at every sign-in; see those files' own comments.)
 *
 * D#37 WS-L1 (correction C19c criterion 5): gains exactly one more
 * field, `workspace_access` -- nothing else changes. Read in parallel
 * with the other two, same as before, so WS-D criterion 2's four
 * parallel shell preloads stay parallel and no serial round-trip is
 * added.
 */
async function meResponse(session: VerifiedSession, deps: SessionRouteDeps): Promise<NextResponse> {
  const [profile, role, workspaceAccess] = await Promise.all([
    getUserProfile(deps.platformOpsPool, session.userId),
    getMemberRole(deps.appUserPool, session.accountId, session.userId),
    workspaceAccessForSession(session, deps),
  ]);
  // The security-expert's rule (D#37 body): "auth/me and profile return
  // 401 with no body ... and never a default row." A vanished user row
  // (deleted between sign-in and this request), or one whose
  // github_login is unexpectedly null (a row that reached this state
  // without ever going through findOrCreateUserByGithub, which always
  // writes it), gets the same 401 an absent session gets -- never a
  // fabricated identity.
  if (profile === null || profile.githubLogin === null) return empty401();
  const body = {
    username: profile.githubLogin,
    email: profile.email,
    is_admin: role === "owner" || role === "admin",
    id: opaqueUserId(session.userId),
    storage_ns: storageNamespace(session.accountId),
    workspace_access: workspaceAccess,
  };
  return applySecurityHeaders(applyNoStore(NextResponse.json(body)));
}

/**
 * D#37 WS-F6 (criterion 2, as amended by C19e and the owner's 2026-09-25
 * ruling): there is no licence route and no activation module in cloud;
 * a subscription unlocks the workspace. No plan on main excludes an app
 * (the plan data carries no app list), so the real mapping has two states, read
 * from the same `workspace_access` the gate uses: an open workspace allows
 * every shipped app (an empty map with `default: "allow"` names none,
 * so none is ever denied); any other state denies by default. The shell
 * never asks for a gated account (WS-L1), so the deny answer is the
 * server's own fail-closed floor. Enforcement stays where it was:
 * every `/v1` handler and `reserve()` re-check the account.
 */
async function entitlementsResponse(session: VerifiedSession, deps: SessionRouteDeps): Promise<NextResponse> {
  const access = await workspaceAccessForSession(session, deps);
  const body = { entitlements: {}, default: access === "open" ? "allow" : "deny" };
  return applySecurityHeaders(applyNoStore(NextResponse.json(body)));
}

function planEntry(p: Plan) {
  return {
    id: p.id,
    price_usd_month: p.priceUsdPerMonth,
    repo_limit: p.repoLimit,
    always_on_security_reviewer: p.alwaysOnSecurityReviewer,
    priority_queue: p.priorityQueue,
    compute_cap_usd_month: p.computeCapUsdPerMonth,
    foreground_compute_usd_month: p.foreground.usdPerMonth,
    background_compute:
      p.background.kind === "flat"
        ? { kind: "flat" as const, usd_month: p.background.usdPerMonth }
        : {
            kind: "scaling" as const,
            base_usd_month: p.background.baseUsdPerMonth,
            per_repo_usd_month: p.background.perRepoUsdPerMonth,
            ceiling_usd_month: p.background.ceilingUsdPerMonth,
          },
  };
}

/**
 * D#37 WS-F6 (G1, criterion 4): the plan list, read straight from the plan
 * source (the plan data) and never retyped. With the plan data unavailable it answers 503 `plan_data_unavailable`, never a default list. Read-only and session-gated like its
 * siblings. `viewer` carries the two facts the plan screens need and no
 * other route gives a browser: whether the caller is the account's owner
 * (only an owner may open Checkout) and whether a partner bills the
 * account (then nothing is sold here). Both come from the session's own
 * account, never a caller-supplied value.
 */
async function plansResponse(session: VerifiedSession, deps: SessionRouteDeps): Promise<NextResponse> {
  let plans: Plan[];
  try {
    plans = listPlans();
  } catch (error) {
    if (error instanceof PlanDataMissingError) {
      const body = { error: { code: "plan_data_unavailable", message: "Plans are unavailable right now" } };
      return applySecurityHeaders(applyNoStore(NextResponse.json(body, { status: 503 })));
    }
    throw error;
  }
  const { accountId, userId } = session;
  const [role, partnerBilled] = await Promise.all([
    getMemberRole(deps.appUserPool, accountId, userId),
    withTenant(deps.appUserPool, accountId, userId, async (client) => {
      const { rows } = await client.query<{ partner_billed: boolean }>(
        "SELECT (partner_id IS NOT NULL) AS partner_billed FROM accounts WHERE id = $1",
        [accountId],
      );
      return rows[0]?.partner_billed === true;
    }),
  ]);
  const body = {
    plans: plans.map(planEntry),
    viewer: { is_owner: role === "owner", partner_billed: partnerBilled },
  };
  return applySecurityHeaders(applyNoStore(NextResponse.json(body)));
}

/**
 * D#37 WS-C criterion 4: "GET /api/preferences -> {}, POST /api/preferences
 * -> 204 (localStorage stays the store of record)." Deliberately no
 * persistence: this route exists only so the fork has something to call
 * (and to gate behind a session, per criterion 5's "every authenticated
 * shell route"), not to store anything server-side.
 */
function preferencesResponse(method: string): NextResponse {
  if (method === "POST") {
    return applySecurityHeaders(applyNoStore(new NextResponse(null, { status: 204 })));
  }
  return applySecurityHeaders(applyNoStore(NextResponse.json({})));
}

async function resourceResponse(
  resource: ShellSessionResource,
  session: VerifiedSession,
  req: NextRequest,
  deps: SessionRouteDeps,
): Promise<NextResponse> {
  switch (resource) {
    case "me":
      return meResponse(session, deps);
    case "entitlements":
      return entitlementsResponse(session, deps);
    case "plans":
      return plansResponse(session, deps);
    case "preferences":
      return preferencesResponse(req.method);
  }
}

export async function shellSessionHandler(
  req: NextRequest,
  deps: SessionRouteDeps,
  options: SessionGuardOptions = {},
): Promise<NextResponse> {
  const shellPath = req.headers.get(SHELL_PATH_HEADER);
  const resource = resourceForShellPath(shellPath);
  // Not reached through one of the five rewritten paths -- this internal
  // module has no public shape of its own to expose.
  if (!resource) {
    return applySecurityHeaders(NextResponse.json(null, { status: 404 }));
  }

  // Security fix round item 1 (CWE-613): resolveActiveSession is the
  // shared helper (lib/shell/session-guard.ts) that verifies the cookie
  // AND re-checks users.session_epoch -- the same check every other
  // Node-runtime handler that honours this cookie now uses. Item 4
  // wires refreshSession into it too: a successful resolution slides
  // the idle deadline forward, applied to the outgoing response below.
  const resolved = await resolveActiveSession(req, { platformOpsPool: deps.platformOpsPool }, options);
  if (!resolved) return empty401();

  const res = await resourceResponse(resource, resolved.session, req, deps);
  return applyRefreshedSessionCookie(res, resolved.refreshedToken);
}
