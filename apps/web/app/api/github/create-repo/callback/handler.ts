import { reportError } from "@fx/telemetry";
import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { appUserPool, platformOpsPool } from "@fx/api/src/sse/pools.js";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { pgSessionLimiter, SESSION_LIMITS, type SessionSubject } from "@fx/api/src/ratelimit/session.js";
import {
  createCustomerRepo,
  loadAppCredentials,
  verifyCreateRepoState,
  type AppCredentialsSource,
  type CreateRepoDeps,
  type CreateRepoInput,
  type CreateRepoResult,
} from "@fx/github";
import { buildRepoSyncDeps } from "../../../../../lib/github/repoSync";
import { applyRefreshedSessionCookie, resolveActiveSession } from "../../../../../lib/shell/session-guard";

/**
 * D#2 RC-1b: where GitHub's user authorization sends the browser back to
 * finish creating a repo. Like the install callback it answers only 302 to our
 * own root path: the outcome is one fixed word, and the only other values are
 * https://github.com URLs that the service built from validated parts, checked
 * again here. No query value and no GitHub text is echoed, and nothing is logged.
 */
export interface CreateRepoCallbackDeps {
  platformOpsPool: Pool;
  appUserPool: Pool;
  appCredentials: AppCredentialsSource;
  env: Record<string, string | undefined>;
  create?: (deps: CreateRepoDeps, input: CreateRepoInput) => Promise<CreateRepoResult>;
  /** Counts this visit against the account's GitHub-return budget and throws RateLimitedError when over it. The default is wired to Postgres. */
  limitSession?: (subject: SessionSubject) => Promise<void>;
}

export function defaultCreateRepoCallbackDeps(): CreateRepoCallbackDeps {
  const appPool = appUserPool();
  return {
    platformOpsPool: platformOpsPool(),
    appUserPool: appPool,
    appCredentials: loadAppCredentials(process.env),
    env: process.env,
    limitSession: pgSessionLimiter(appPool, SESSION_LIMITS.githubReturn),
  };
}

const OUTCOMES = new Set([
  "ok", "created_not_connected", "name_taken", "visibility_not_allowed", "refused", "github_busy", "rate_limited", "install_first", "failed",
]);

/** Only a plain https://github.com address survives. */
function githubUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "github.com" && u.port === "" && !u.username && !u.password ? u.href : null;
  } catch {
    // fx-swallow-ok: an address that does not parse as a URL is simply not shown; nothing fails
    return null;
  }
}

function redirect(result: CreateRepoResult, refreshedToken: string | null = null): NextResponse {
  const outcome = OUTCOMES.has(result.outcome) ? result.outcome : "failed";
  const params = new URLSearchParams({ create: outcome });
  if (outcome === "created_not_connected") {
    const repo = githubUrl(result.repoUrl);
    const settings = githubUrl(result.installationUrl);
    if (repo) params.set("repo_url", repo);
    if (settings) params.set("settings_url", settings);
  }
  const res = new NextResponse(null, { status: 302, headers: { location: `/?${params.toString()}`, "cache-control": "no-store" } });
  return applyRefreshedSessionCookie(res, refreshedToken);
}

export async function createRepoCallbackHandler(req: NextRequest, deps?: CreateRepoCallbackDeps): Promise<NextResponse> {
  const d = deps ?? defaultCreateRepoCallbackDeps();
  const resolved = await resolveActiveSession(req, { platformOpsPool: d.platformOpsPool });
  if (!resolved) return redirect({ outcome: "failed" });
  const { session, refreshedToken } = resolved;

  // The state is checked before any work: signature, expiry, and that it was minted for this very session.
  const secret = d.env.GITHUB_INSTALL_STATE_SECRET;
  const state = req.nextUrl.searchParams.get("state");
  const claims = secret && Buffer.byteLength(secret, "utf8") >= 32 && state ? verifyCreateRepoState(state, secret) : null;
  const code = req.nextUrl.searchParams.get("code");
  if (!state || !code || !claims || claims.account_id !== session.accountId || claims.user_id !== session.userId) {
    return redirect({ outcome: "failed" }, refreshedToken);
  }

  // The state is good, so this visit would call GitHub. Counted per account; a limiter that cannot run is a refusal.
  try {
    await d.limitSession?.({ accountId: session.accountId, userId: session.userId });
  } catch (err) {
    // A refusal by the limiter is the answer; any other failure means the limiter could not run.
    if (!(err instanceof RateLimitedError)) reportError(err, { stage: "github.create_repo.limit", route: req.nextUrl.pathname });
    return redirect({ outcome: err instanceof RateLimitedError ? "rate_limited" : "failed" }, refreshedToken);
  }

  let result: CreateRepoResult;
  try {
    const deps2: CreateRepoDeps = { ...buildRepoSyncDeps(d), env: d.env };
    result = await (d.create ?? createCustomerRepo)(deps2, { accountId: session.accountId, userId: session.userId, code, state });
  } catch (err) {
    reportError(err, { stage: "github.create_repo", route: req.nextUrl.pathname });
    result = { outcome: "failed" };
  }
  return redirect(result, refreshedToken);
}
