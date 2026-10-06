import { reportError } from "@fx/telemetry";
import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { createPool } from "@fx/db/src/pool";
import { INSTALLATION_APP_KINDS, type InstallationAppKind } from "@fx/core/src/repos/appKinds.js";
import { verifyInstallState } from "@fx/api/src/github/installUrl.js";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { pgSessionLimiter, SESSION_LIMITS, type SessionSubject } from "@fx/api/src/ratelimit/session.js";
import {
  completeInstall,
  loadAppCredentials,
  type AppCredentialsSource,
  type CompleteInstallDeps,
  type CompleteInstallInput,
  type InstallOutcome,
  type SyncRepos,
} from "@fx/github";
import { appUserPool } from "@fx/api/src/sse/pools.js";
import { buildSyncRepos } from "../../../../../../lib/github/repoSync";
import { applyRefreshedSessionCookie, resolveActiveSession } from "../../../../../../lib/shell/session-guard";

/**
 * D#2 H17a: a GitHub App's Setup URL. The App kind comes from the path, never
 * the query. It answers only 302 to a few fixed relative paths, so no query value
 * is echoed, and it writes one fixed outcome line (no id, no name, no query value).
 */
export interface InstallCallbackDeps {
  platformOpsPool: Pool;
  appCredentials: AppCredentialsSource;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  syncRepos?: SyncRepos;
  complete?: (deps: CompleteInstallDeps, input: CompleteInstallInput) => Promise<InstallOutcome>;
  /** Counts this visit against the account's GitHub-return budget and throws RateLimitedError when over it. The default is wired to Postgres. */
  limitSession?: (subject: SessionSubject) => Promise<void>;
}

let cachedPool: Pool | undefined;
let cachedAppUserPool: Pool | undefined;

export function defaultInstallCallbackDeps(): InstallCallbackDeps {
  const url = process.env.DATABASE_URL_PLATFORM_OPS;
  if (!url) throw new Error("DATABASE_URL_PLATFORM_OPS must be set");
  cachedPool ??= createPool(url);
  const appCredentials = loadAppCredentials(process.env);
  // Repo sync needs the tenant pool; without it the claim still works and the next webhook syncs.
  const appUrl = process.env.DATABASE_URL_APP_USER;
  if (appUrl) cachedAppUserPool ??= createPool(appUrl);
  return {
    platformOpsPool: cachedPool,
    appCredentials,
    env: process.env,
    limitSession: (subject) => pgSessionLimiter(appUserPool(), SESSION_LIMITS.githubReturn)(subject),
    ...(cachedAppUserPool ? { syncRepos: buildSyncRepos({ platformOpsPool: cachedPool, appUserPool: cachedAppUserPool, appCredentials }) } : {}),
  };
}

function redirect(outcome: InstallOutcome | "rate_limited", refreshedToken: string | null = null): NextResponse {
  const res = new NextResponse(null, {
    status: 302,
    headers: { location: `/?install=${outcome}`, "cache-control": "no-store" },
  });
  return applyRefreshedSessionCookie(res, refreshedToken);
}

export async function installCallbackHandler(
  req: NextRequest,
  kind: string,
  deps?: InstallCallbackDeps,
): Promise<NextResponse> {
  if (!(INSTALLATION_APP_KINDS as readonly string[]).includes(kind)) {
    return new NextResponse(null, { status: 404 });
  }
  const appKind = kind as InstallationAppKind;
  const d = deps ?? defaultInstallCallbackDeps();

  const resolved = await resolveActiveSession(req, { platformOpsPool: d.platformOpsPool });
  if (!resolved) return redirect("failed");
  const { session, refreshedToken } = resolved;

  const secret = d.env.GITHUB_INSTALL_STATE_SECRET;
  const state = req.nextUrl.searchParams.get("state");
  const claims = secret && state ? verifyInstallState(state, secret, appKind) : null;
  if (!claims || claims.account_id !== session.accountId || claims.user_id !== session.userId) {
    return redirect("failed", refreshedToken);
  }

  // The state is good, so this visit would call GitHub. Counted per account; over the cap, nothing is called.
  // A limiter that cannot run is a refusal, never an unlimited pass.
  try {
    await d.limitSession?.({ accountId: session.accountId, userId: session.userId });
  } catch (err) {
    // A refusal by the limiter is the answer; any other failure means the limiter could not run.
    if (!(err instanceof RateLimitedError)) reportError(err, { stage: "github.install.limit", route: req.nextUrl.pathname });
    return redirect(err instanceof RateLimitedError ? "rate_limited" : "failed", refreshedToken);
  }

  const complete = d.complete ?? completeInstall;
  let outcome: InstallOutcome;
  try {
    outcome = await complete(
      { platformOpsPool: d.platformOpsPool, appCredentials: d.appCredentials, env: d.env, fetchImpl: d.fetchImpl, syncRepos: d.syncRepos },
      {
        kind: appKind,
        accountId: session.accountId,
        userId: session.userId,
        installationId: req.nextUrl.searchParams.get("installation_id"),
        code: req.nextUrl.searchParams.get("code"),
      },
    );
  } catch (err) {
    reportError(err, { stage: "github.install", route: req.nextUrl.pathname });
    outcome = "failed";
  }
  console.info(`install callback: ${appKind} outcome=${outcome}`);
  return redirect(outcome, refreshedToken);
}
