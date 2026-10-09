import type { NextRequest, NextResponse } from "next/server";
import { loadGithubForwardConfig, type GithubForwardConfig } from "@fx/runner";
import { createRunnerCloneBudget, createRunnerGitResolver, createRunResolver } from "@fx/github";
import { createPool } from "@fx/db/src/pool";
import { defaultGhProxyHandlerDeps, ghProxyHandler, type GhProxyHandlerDeps } from "./handler";

// Next.js requires `runtime`/`dynamic` literally in the route file, not
// re-exported from a barrel (it warned and fell back to defaults when
// these used to live in handler.ts). D#2 body criterion 6: nodejs runtime
// so the clone response streams rather than buffers.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * D#2 H13b / D#66 O1: the ONE `loadGithubForwardConfig(process.env)` call
 * this task makes, in the proxy route itself. Lazy, not a bare top-level
 * statement: `next build`'s page-data collection step IMPORTS and
 * EXECUTES this module with no `FX_GH_FORWARD_*` env set (a real `next
 * build` failed here before this fix -- see the PR's Gate 2 evidence).
 * `cachedDeps` keeps this "once per cold start" anyway: the first real
 * request builds it (config load + O4's cold-start check), every request
 * after reuses it.
 */
let cachedDeps: GhProxyHandlerDeps | undefined;

/**
 * The proxy connects as its own narrow login (migration 0696), never as
 * platform_ops, and has no fallback to it: a missing value denies every
 * request.
 */
function requireGhProxyUrl(): string {
  const value = process.env.DATABASE_URL_GH_PROXY;
  if (!value) {
    // Fix round 1 (suggestion, D#2 C27): logged LOUDLY on every request
    // this fires for, not just the first -- see the comment on `deps()`
    // below for why a bare `throw` here used to go silent after the first
    // request.
    console.error("gh-proxy route: DATABASE_URL_GH_PROXY is not set -- every request is denied until this is fixed");
    throw new Error("DATABASE_URL_GH_PROXY must be set");
  }
  return value;
}

function deps(): GhProxyHandlerDeps {
  if (!cachedDeps) {
    // Fix round 1 (suggestion, D#2 C27): build into a LOCAL variable and
    // only assign `cachedDeps` once every step below has succeeded. The
    // previous version assigned `cachedDeps = defaultGhProxyHandlerDeps(...)`
    // BEFORE calling `requireGhProxyUrl()`, so when that call threw,
    // `cachedDeps` was already a truthy (if incompletely wired) object --
    // `if (!cachedDeps)` was false on every request after the first, so the
    // missing-env-var error, and its log, fired exactly once ever, even
    // though the misconfiguration was still live on every request after
    // it. Never caching a partially-built value means the failure -- and
    // the log above -- reproduces on every request until the env var is
    // actually fixed, not just the first.
    const ghProxyUrl = requireGhProxyUrl();
    const githubForward: GithubForwardConfig = loadGithubForwardConfig(process.env);
    const built = defaultGhProxyHandlerDeps(githubForward);
    // D#2 H13c: the production resolver. handler.ts (H13b) stays fail-
    // closed by default (`defaultSandboxRunResolver`) -- this is the one
    // line that overrides it with the real, Postgres-backed resolver.
    const ghProxyPool = createPool(ghProxyUrl);
    built.resolveSandboxRun = createRunResolver(ghProxyPool);
    // D#6 R5a-2c: the runner path's lease lookup, on the same narrow login (it may execute the two resolver functions and nothing else).
    built.resolveRunnerGit = createRunnerGitResolver(ghProxyPool);
    built.cloneBudget = createRunnerCloneBudget(ghProxyPool);
    cachedDeps = built;
  }
  return cachedDeps;
}

async function dispatch(req: NextRequest): Promise<NextResponse> {
  return ghProxyHandler(req, deps());
}

// D#2 Correction C28 §3 item 7: every method decide() (gh-policy's
// ALLOWED_METHODS) recognises is routable -- PUT, PATCH and DELETE are new
// here; GET, HEAD and POST were already exported. Any OTHER method still
// 405s, since Next.js itself answers that for a method with no export.
export const GET = dispatch;
export const HEAD = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
