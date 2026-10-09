import type { Pool } from "pg";
import { SignedJobSchema, type Job, type StopReason } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { signRunnerGitTicket, type GitTicketRepo, type RunnerGitTicketSigner } from "@fx/github";
import { guarded } from "./runActions.js";
import { leaseVerdict, requireLease, stopReasonFor, type HeartbeatRunnerRunInput } from "./runnerClaims.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";

/**
 * D#6 R5a-2b (C27 section 1.1): the worker's half of `POST /api/runner/git-ticket`.
 *
 *   gitTicketContext  the lease fence, WITHOUT extending the lease (a ticket is not progress, so asking for one never keeps a run alive), then
 *                     the facts the route decides on, all from our own rows: the run's role, runtime and OWN execution mode, the dispatch
 *                     repository and the signed job. Anything but `ok` from the fence is the same 409 stop reply heartbeat gives.
 *   signGitTicket     signs the ticket with the key this worker was built with. Null while the key or the audience is not configured.
 *
 * AUTHORITY WARNING, as for the other lease methods: `accountId` and `runnerId` MUST be the ones a verified runner request carries.
 * `gitTicketContext` decides nothing: the route refuses a run that is not a cloud-verified runner run, and computes the branch.
 */

export interface GitTicketContext {
  role: string;
  runtime: string;
  /** The RUN's own mode (`agent_runs.execution_mode`), never the repository's current one (C24 section 2). */
  executionMode: string;
  /** The run's dispatch repository, or null if it has none (or no owner and name). */
  repo: GitTicketRepo | null;
  /** The signed job we issued for the run, or null if the stored value does not parse. */
  job: Job | null;
}

export type GitTicketContextResult = { kind: "fenced"; reason: StopReason } | ({ kind: "context" } & GitTicketContext);

export interface SignGitTicketInput {
  /** The cloud origin: the route derives it from FX_APP_ORIGIN. */
  issuer: string;
  runnerId: string;
  accountId: string;
  runId: string;
  leaseGeneration: number;
  repo: GitTicketRepo;
  ref: string;
}

export interface SignedGitTicket {
  ticket: string;
  expiresAt: Date;
  /** The origin of the proxy the ticket is good for: the origin of its audience. */
  proxyOrigin: string;
}

export interface RunnerGitTicketFacade {
  gitTicketContext(input: HeartbeatRunnerRunInput): Promise<GitTicketContextResult>;
  signGitTicket(input: SignGitTicketInput): Promise<SignedGitTicket | null>;
}

export interface RunnerGitTicketDeps {
  /** Tests inject a fixed clock (milliseconds since the epoch). */
  now?: () => number;
  limits?: RunnerLimitsSource;
  /** The signing key, or null while it is not configured. */
  signer: RunnerGitTicketSigner | null;
  /** `githubProxyForwardUrl(config)`, the one audience function; null while the forward host is not configured. */
  audience: string | null;
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerGitTicketFacade(runnerPool: Pool, deps: RunnerGitTicketDeps): RunnerGitTicketFacade {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;

  return {
    gitTicketContext: (input) =>
      guarded(async () => {
        requireLease(input);
        const at = new Date(now());
        return withTenant(runnerPool, input.accountId, async (client): Promise<GitTicketContextResult> => {
          // Fence only. `extendSeconds = 0` leaves the lease where it is: a ticket request is not a sign of life.
          const held = await leaseVerdict(client, input, at, 0, limits(input.accountId).maxRunWallClockMs);
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const { rows } = await client.query<{ role: string; runtime: string; execution_mode: string; job_signed: unknown; repo_id: string | null; gh_owner: string | null; gh_name: string | null }>(
            `SELECT ar.role, ar.runtime, ar.execution_mode, ar.job_signed, r.id AS repo_id, r.gh_owner, r.gh_name
               FROM agent_runs ar
               LEFT JOIN repos r ON r.account_id = ar.account_id AND r.id = ar.dispatch_repo_id
              WHERE ar.account_id = $1 AND ar.id = $2`,
            [input.accountId, input.runId],
          );
          const row = rows[0];
          // The fence has just locked this row, so it exists; if it somehow does not, nothing here can be trusted and the run is a stop.
          if (!row) return { kind: "fenced", reason: "stale_generation" };
          const parsed = SignedJobSchema.safeParse(row.job_signed);
          return {
            kind: "context",
            role: row.role,
            runtime: row.runtime,
            executionMode: row.execution_mode,
            repo: row.repo_id && row.gh_owner && row.gh_name ? { id: row.repo_id, owner: row.gh_owner, name: row.gh_name } : null,
            job: parsed.success ? parsed.data.job : null,
          };
        });
      }),

    signGitTicket: (input) =>
      guarded(async () => {
        if (!deps.signer || !deps.audience) return null;
        const { ticket, expiresAt } = await signRunnerGitTicket({ ...input, audience: deps.audience }, deps.signer, new Date(now()));
        return { ticket, expiresAt, proxyOrigin: new URL(deps.audience).origin };
      }),
  };
}
