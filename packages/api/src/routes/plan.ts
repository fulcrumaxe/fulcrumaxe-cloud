import { z } from "zod";
import { assertRepoIdShape, getRepo } from "@fx/core/src/repos/read.js";
import {
  beginPlanImport,
  executePlanImport,
  getLatestPlanImport,
  getPlanView,
  ImportRateLimitedError,
  ImportRepoNotConnectedError,
  ImportRunningError,
  PLAN_PAGE_SIZE,
  type PlanSource,
} from "@fx/core/src/plan/index.js";
import type { RouteEntry } from "../registry.js";
import { ImportRunningApiError, NeverImportedError, PlanImportUnavailableError, RateLimitedError, RepoNotConnectedApiError } from "../errors.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";

/**
 * D#483 S3 (live build L1): the plan import's three routes.
 *
 *   POST /repos/{id}/plan-imports          start an import (session only, owner or admin). Answers 202 at once; the import
 *                                          reads the repository through the read-only GitHub App and writes its rows in
 *                                          one transaction after the response.
 *   GET  /repos/{id}/plan-imports/latest   the newest import of any state, or 404 `never_imported`.
 *   GET  /repos/{id}/plan                  the milestones with {tasks, done, remaining}, plus a page of tasks; `?format=full`
 *                                          answers every task with its key, milestone and status (for acceptance A1).
 *
 * M0 (read-only, nothing starts): an import writes only the four plan tables, through its own database role, and never
 * files a run action or creates a work item. The GitHub side is `planImportDeps.openSource`, which the app registers; it
 * can only ask GitHub for reads (see @fx/github planReadClient.ts). With none registered, the start route answers 503
 * and writes nothing.
 */
export interface PlanImportDeps {
  /** The read-only source for one repository, or null until production registers it. */
  openSource: ((target: { repoId: string; owner: string; name: string }) => PlanSource) | null;
  /** Runs the import after the response (Next's `after`). The default just starts it. */
  schedule: (work: () => Promise<unknown>) => void;
}

export const planImportDeps: PlanImportDeps = {
  openSource: null,
  schedule: (work) => {
    void work();
  },
};

const OWNER_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const repoParams = z.object({ id: z.string() });

const requestEntry = z.object({ method: z.string(), path: z.string(), status: z.number().int() });
const importSchema = z.object({
  id: z.string().uuid(),
  repo_id: z.string().uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  level: z.string().nullable(),
  source_path: z.string().nullable(),
  source_sha: z.string().nullable(),
  counts: z.record(z.string(), z.unknown()),
  truncated: z.boolean(),
  error_code: z.string().nullable(),
  error_detail: z.string().nullable(),
  max_merged_pr: z.number().int().nullable(),
  github_requests: z.array(requestEntry).nullable(),
  token_permissions: z.record(z.string(), z.string()).nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

const startedSchema = z.object({ import_id: z.string().uuid(), action_id: z.null(), state: z.literal("running") });

const planSchema = z.object({
  latest_import: importSchema.nullable(),
  imported_from: importSchema.nullable(),
  milestones: z.array(z.object({ key: z.string(), title: z.string(), position: z.number().int(), tasks: z.number().int(), done: z.number().int(), remaining: z.number().int() })),
  totals: z.object({ tasks: z.number().int(), done: z.number().int(), remaining: z.number().int() }),
  tasks: z.array(
    z.object({
      task_key: z.string(),
      milestone_key: z.string(),
      title: z.string(),
      status: z.enum(["done", "partial", "open", "not_started", "pending_spec"]),
      planned_prs: z.number().int(),
      merged_prs: z.array(z.number().int()),
      open_prs: z.array(z.number().int()),
      owner_process: z.enum(["product", "internal_loop"]),
    }),
  ),
  next_cursor: z.string().nullable(),
  tasks_truncated: z.boolean(),
});

const planQuery = z.object({
  milestone: z.string().max(120).optional(),
  status: z.enum(["done", "remaining"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  format: z.literal("full").optional(),
});

function toImportBody(row: Awaited<ReturnType<typeof getLatestPlanImport>> & object): z.infer<typeof importSchema> {
  return row as unknown as z.infer<typeof importSchema>;
}

export const planRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/repos/{id}/plan-imports",
    operationId: "startPlanImport",
    summary: "Import the repository's existing plan, read-only",
    description:
      "Session only, owner or admin; a token is refused. Takes no request body. Starts an import of the repository's roadmap file (read from its default branch: `.fulcrumaxe/roadmap.json`, then `.autonomous-team/roadmap.json`, then `roadmap.json`) through the read-only GitHub App. " +
      "The import only ever reads GitHub (GET requests and read-only GraphQL, with a token whose permissions are checked to be read-only), writes only the plan tables and the inbox of proposals, and starts no work and no agent run. " +
      "Answers 202 `{ import_id, action_id, state }` at once (`action_id` is null: the live build runs the import in the request, not as a queued action); read the outcome with `GET /api/v1/repos/{id}/plan-imports/latest`. " +
      "One import runs at a time per repository. Limits: 6 starts per repository per hour and 20 per account per hour, answered 429 `rate_limited` with `Retry-After`.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.planImport,
    paramsSchema: repoParams,
    responseSchema: startedSchema,
    successStatus: 202,
    extraResponses: {
      "403": "Error `session_required` (a token) or `insufficient_role` (below admin).",
      "404": "Error `not_found`: the repository does not exist in this account.",
      "409": "Error `import_running` (an import is already running for this repository) or `repo_not_connected` (the GitHub App is not installed on it any more).",
      "429": "Error `rate_limited`: too many imports in the last hour; `Retry-After` says how long to wait.",
      "503": "Error `plan_import_unavailable`: no GitHub reader is registered. Nothing was written.",
    },
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const open = planImportDeps.openSource;
      if (!open) throw new PlanImportUnavailableError();
      const ids = { pool: ctx.pool, principal: { accountId: ctx.principal.accountId, userId: ctx.principal.userId } };
      const repo = await getRepo(ids, repoId);
      const [owner, name] = (repo.fullName ?? "").split("/");
      if (repo.installState !== "installed" || !owner || !name || !OWNER_RE.test(owner) || !NAME_RE.test(name)) throw new RepoNotConnectedApiError();
      const importId = await beginPlanImport(ctx.pool, ids.principal, repoId).catch((err: unknown) => {
        if (err instanceof ImportRunningError) throw new ImportRunningApiError();
        if (err instanceof ImportRepoNotConnectedError) throw new RepoNotConnectedApiError();
        if (err instanceof ImportRateLimitedError) throw new RateLimitedError(err.retryAfterSeconds);
        throw err;
      });
      const source = open({ repoId, owner, name });
      planImportDeps.schedule(() =>
        executePlanImport({ pool: ctx.pool, principal: ids.principal, repoId, importId, source }).catch(() => {
          // fx-swallow-ok: executePlanImport records its own failures on the import row; what reaches here (the row was closed as interrupted, or the database was down) leaves nothing to write, and the next start closes a stale row
          console.warn(JSON.stringify({ event: "plan_import.run_aborted", import_id: importId }));
        }),
      );
      return { import_id: importId, action_id: null, state: "running" as const };
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/plan-imports/latest",
    operationId: "getLatestPlanImport",
    summary: "The repository's newest plan import",
    description:
      "The newest import of any state, with its level, source file and commit, counts, whether it stopped at a bound (`truncated`), the error code and detail of a failed one, `max_merged_pr`, and the evidence of what it asked GitHub: `github_requests` (method, path, status) and the `token_permissions` GitHub reported for the minted token. " +
      "404 `never_imported` when the repository has no import yet.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoParams,
    responseSchema: importSchema,
    extraResponses: { "404": "Error `not_found` (the repository does not exist in this account) or `never_imported`." },
    async handler(ctx, input) {
      const row = await getLatestPlanImport({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      if (!row) throw new NeverImportedError();
      return toImportBody(row);
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/plan",
    operationId: "getRepoPlan",
    summary: "The repository's imported plan: milestones and tasks",
    description:
      "`milestones` lists each milestone with `tasks`, `done` and `remaining`, derived from the task rows on every read (the counts stored on an import are that import's own historical stamp). `tasks` is one page (`milestone`, `status` = `done` or `remaining`, `cursor`, `limit` up to 100) of the tasks, ordered by key; `next_cursor` is null on the last page. " +
      "`?format=full` answers every task in one response (with `next_cursor` null), for the dogfood comparison; it is capped at 5000 tasks, and `tasks_truncated` is true when the cap cut tasks off. `imported_from` is the newest import that succeeded, which the rows came from; `latest_import` is the newest of any state, so a failed re-import is visible while the previous data stays.",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoParams,
    querySchema: planQuery,
    responseSchema: planSchema,
    extraResponses: { "404": "Error `not_found`: the repository does not exist in this account." },
    async handler(ctx, input) {
      const q = (input.query ?? {}) as z.infer<typeof planQuery>;
      const view = await getPlanView({ pool: ctx.pool, principal: ctx.principal }, input.params.id!, {
        ...(q.milestone !== undefined ? { milestone: q.milestone } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        limit: q.limit ? Math.min(Number(q.limit), PLAN_PAGE_SIZE) : PLAN_PAGE_SIZE,
        full: q.format === "full",
      });
      return view as unknown as z.infer<typeof planSchema>;
    },
  },
];
