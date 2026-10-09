import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";
import type { Product } from "@fx/gh-policy";

/**
 * D#6 R5a-2a: the gh-proxy's one question about a runner's git request. "Is this lease still live, and what repository,
 * role and installation does it stand for?" It calls migration 0765's `resolve_runner_git_request` on the same narrow
 * pool the sandbox resolver uses (`DATABASE_URL_GH_PROXY`, a member of `run_binding_resolver`), so the login can do nothing
 * else. The run, runner, generation and repo come from a ticket the proxy has already verified, never from a URL part.
 *
 * Every answer the proxy cannot act on is `null`: a database error, a row count other than one, an answer outside the
 * known verdicts, or an `ok` row that is incomplete. The proxy treats `null` as a generic refusal, as `createRunResolver`'s
 * callers do. A failure is reported as a coded class only (never the error's text).
 */

/**
 * The most full clones one repository may make in a UTC day. The same constant is inside the database function (the limit is
 * never an argument, so a caller cannot move it); a test keeps the two equal.
 */
export const FULL_CLONES_PER_REPO_PER_DAY = 3;

/** Every verdict but `ok`, in the order the function decides them. */
export const RUNNER_GIT_DENIALS = [
  "unknown",
  "stale",
  "not_running",
  "revoked",
  "expired",
  "not_verified",
  "no_repo",
  "installation_ambiguous",
  "clone_limited",
] as const;
export type RunnerGitDenial = (typeof RUNNER_GIT_DENIALS)[number];

export interface RunnerGitRequest {
  runnerId: string;
  accountId: string;
  runId: string;
  /** The lease generation signed into the ticket. */
  generation: number;
  repoId: string;
  /** True when the request is a full clone: it is counted against the repository's daily allowance. */
  fullClone: boolean;
}

export interface RunnerGitGrant {
  verdict: "ok";
  role: string;
  product: Product;
  installationId: number;
  appKind: string | null;
  owner: string;
  repo: string;
}

export type RunnerGitResolution = RunnerGitGrant | { verdict: RunnerGitDenial };

export type RunnerGitResolver = (request: RunnerGitRequest) => Promise<RunnerGitResolution | null>;

interface ResolverRow {
  verdict: string;
  role: string | null;
  product: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  gh_installation_id: string | null;
  app_kind: string | null;
}

const RESOLVE_QUERY = `SELECT verdict, role, product, gh_owner, gh_name, gh_installation_id, app_kind
                         FROM public.resolve_runner_git_request($1, $2, $3, $4, $5, $6)`;

const STAGE = "github.runner_git_resolve";
const VALID_PRODUCTS = new Set<string>(["team", "sitekit"] satisfies Product[]);
const DENIALS: ReadonlySet<string> = new Set(RUNNER_GIT_DENIALS);
const MAX_INT4 = 2_147_483_647;

/** Builds the resolver on the narrow gh-proxy pool. */
export function createRunnerGitResolver(ghProxyPool: Pool): RunnerGitResolver {
  return async function resolveRunnerGitRequest(request: RunnerGitRequest): Promise<RunnerGitResolution | null> {
    if (!Number.isSafeInteger(request.generation) || request.generation < 1 || request.generation > MAX_INT4) return null;
    if (typeof request.fullClone !== "boolean") return null;

    let rows: ResolverRow[];
    try {
      rows = (
        await ghProxyPool.query<ResolverRow>(RESOLVE_QUERY, [
          request.runnerId,
          request.accountId,
          request.runId,
          request.generation,
          request.repoId,
          request.fullClone,
        ])
      ).rows;
    } catch (err) {
      reportError(err, { stage: STAGE });
      return null;
    }

    if (rows.length !== 1) {
      reportError(new Error("runner git resolver answered an unexpected row count"), { stage: STAGE });
      return null;
    }
    const row = rows[0]!;

    if (row.verdict !== "ok") {
      if (DENIALS.has(row.verdict)) return { verdict: row.verdict as RunnerGitDenial };
      reportError(new Error("runner git resolver answered an unknown verdict"), { stage: STAGE });
      return null;
    }

    if (row.role == null || row.gh_owner == null || row.gh_name == null || row.product == null) return null;
    if (!VALID_PRODUCTS.has(row.product)) return null;
    // bigint columns come back as strings from node-postgres.
    const installationId = Number(row.gh_installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;

    return {
      verdict: "ok",
      role: row.role,
      product: row.product as Product,
      installationId,
      appKind: row.app_kind,
      owner: row.gh_owner,
      repo: row.gh_name,
    };
  };
}
