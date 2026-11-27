import { z } from "zod";
import { reportError } from "@fx/telemetry";
import type { Pool } from "pg";
import { descriptionHash } from "@fx/core/src/github/createRepoState.js";
import { validateNewRepo } from "@fx/core/src/github/repoName.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { changeRepoTwin, checkRepoTwinAgain, getRepoTwin, getTwinCreateFacts, TWIN_ENABLED, TwinStateError, type RepoTwin, type TwinAction } from "@fx/core/src/repos/twins.js";
import type { RouteEntry } from "../registry.js";
import { ApiError } from "../errors.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";
import { authorizeCreate } from "./github.js";
import { repoPairingDeps } from "./repoPairing.js";

/**
 * The kill switch. Production never sets it: it is the constant (on since ON-27d4c). Tests flip it.
 * `closePublishPr` (D#845 ON-27c2, set by the app) closes the publish pull request a removed twin still has open on the public repository; with none, nothing is closed.
 */
export const twinRouteDeps: {
  enabled: boolean;
  closePublishPr: ((input: { accountId: string; userId: string; twinId: string }) => Promise<unknown>) | null;
  closeSyncPr: ((input: { accountId: string; userId: string; twinId: string }) => Promise<unknown>) | null;
  /** D#845 ON-27d4c: Merge. Merges the open publish pull request through the App (set by the app). With none, the route answers 503 `not_configured`. */
  mergePr: ((input: { accountId: string; userId: string; twinId: string }) => Promise<TwinMergeAnswer>) | null;
} = { enabled: TWIN_ENABLED, closePublishPr: null, closeSyncPr: null, mergePr: null };

/** The answer `mergePr` gives (the shape of runner-cloud's `TwinMerge`, which this package cannot import). */
export type TwinMergeAnswer =
  | { result: "merged" | "already"; pr: number }
  | { result: "not_found" | "no_open_pr" | "pr_changed" | "pr_blocked" | "github_unavailable" }
  | { result: "twin_state"; state: string };

const enabled = (): void => {
  if (!twinRouteDeps.enabled) throw new ApiError(503, "not_configured", "private twins are not available yet");
};

const idParams = z.object({ id: z.string() });
const createBody = z.object({ name: z.string().optional() }).strict();
const mergeBody = z.object({ pr: z.literal("publish") }).strict();

const twinSchema = z.object({
  id: z.string(),
  public_repo_id: z.string(),
  /** Null until the App can see the private repo. */
  private_repo_id: z.string().nullable(),
  private_name: z.string(),
  state: z.enum(["creating", "not_connected", "seeding", "ready", "paused", "conflict", "refused", "failed", "removed"]),
  overlay_globs: z.array(z.string()),
  published_private_sha: z.string().nullable(),
  synced_public_sha: z.string().nullable(),
  publish_pr: z.number().int().nullable(),
  sync_pr: z.number().int().nullable(),
  failure_code: z.string().nullable(),
  /** Changes merged on the twin that the last parity check found waiting to publish; null before any check has run. */
  merged_count: z.number().int().nullable(),
  /** Changes on the public repo that the last parity check found waiting to come in; null before any check has run. */
  new_changes_count: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const toItem = (t: RepoTwin): z.infer<typeof twinSchema> => ({
  id: t.id, public_repo_id: t.publicRepoId, private_repo_id: t.privateRepoId, private_name: t.privateName, state: t.state, overlay_globs: t.overlayGlobs,
  published_private_sha: t.publishedPrivateSha, synced_public_sha: t.syncedPublicSha, publish_pr: t.publishPr, sync_pr: t.syncPr, failure_code: t.failureCode, merged_count: t.mergedCount, new_changes_count: t.newChangesCount,
  created_at: t.createdAt, updated_at: t.updatedAt,
});

async function change(ctx: { pool: Pool; principal: { accountId: string; userId: string } }, id: string, action: TwinAction): Promise<z.infer<typeof twinSchema>> {
  enabled();
  try {
    const twin = toItem(await changeRepoTwin({ pool: ctx.pool, principal: ctx.principal }, id, action));
    // The removal stands whatever follows: a publish or sync pull request that cannot be closed now stays open on GitHub, and the removed twin ignores its merge. Each close is tried on its own.
    if (action === "remove") {
      for (const [close, stage] of [[twinRouteDeps.closePublishPr, "twin.close_publish_pr"], [twinRouteDeps.closeSyncPr, "twin.close_sync_pr"]] as const) {
        if (close === null) continue;
        try {
          await close({ accountId: ctx.principal.accountId, userId: ctx.principal.userId, twinId: id });
        } catch (closeError) {
          reportError(closeError, { stage });
        }
      }
    }
    return twin;
  } catch (err) {
    if (err instanceof TwinStateError) throw new ApiError(409, "twin_state", `a twin that is ${err.state} cannot be ${action === "remove" ? "removed" : `${action}d`}`, undefined, { state: err.state });
    throw err;
  }
}

const common = { minRole: "admin", idempotency: "never", rateClass: "write", paramsSchema: idParams, responseSchema: twinSchema } as const;
const stateExtra = { "409": "`twin_state`: the twin's state does not allow this (`data.state` is what it is). Nothing changed.", "503": "`not_configured`: private twins are not on yet." };

/** The private twin of a public repo (ON-27a): the create, the read, and the undo routes. Writes are session only and owner or admin. */
export const repoTwinRoutes: RouteEntry[] = [
  {
    method: "POST",
    path: "/api/v1/repos/{id}/twin",
    operationId: "createRepoTwinIntent",
    summary: "Start making the private twin of a public repo with the caller's own GitHub authority",
    description:
      "Session only, owner or admin; `{id}` is the public repo. Returns GitHub's user-authorization URL with a signed state. The twin's repo is created (private, empty, Discussions on, under the public repo's owner) only when the browser comes back through the web callback. `name` defaults to `<name>-private`.",
    extraResponses: {
      "409": "`twin_exists`, `pairing_exists`, `account_not_active` or `install_first`.",
      "422": "`validation_failed` for a bad name, or `twin_repo_not_public` when the repo is not public.",
      "429": "`rate_limited`: the account's repo creations for the hour or day are used.",
      "503": "`not_configured` (private twins are not on yet), `github_app_not_configured` or `github_unavailable`.",
    },
    sessionLimit: SESSION_LIMITS.githubCreateIntent,
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: createBody,
    responseSchema: z.object({ authorize_url: z.string().url() }),
    async handler(ctx, input) {
      enabled();
      const svc = { pool: ctx.pool, principal: ctx.principal };
      const facts = await getTwinCreateFacts(svc, input.params.id!);
      if (facts.hasTwin) throw new ApiError(409, "twin_exists", "this repo already has a private twin");
      if (facts.hasPairing) throw new ApiError(409, "pairing_exists", "this repo is paired with a public code repo; remove the pairing first");
      const inspector = repoPairingDeps.getInspector();
      if (!inspector) throw new ApiError(503, "github_app_not_configured", "the GitHub App is not configured");
      if (facts.fullName === null) throw new ApiError(503, "github_unavailable", "this repo has not been read from GitHub yet; try again");
      const fallback = `${facts.fullName.split("/")[1]}-private`;
      const body = input.body as z.infer<typeof createBody>;
      const valid = validateNewRepo({ name: body.name ?? fallback, visibility: "private", description: undefined, autoInit: false });
      if (!valid.ok) throw new ApiError(422, "validation_failed", "request failed validation", [{ path: valid.path, code: "invalid" }]);
      // Visibility is read again from GitHub, never from what the page said; the owner is the public repo's own.
      let read;
      try {
        read = await inspector.inspect(facts.fullName, ctx.principal.accountId);
      } catch {
        // fx-swallow-ok: the reader's own text is never passed on; any failure is one fixed 503
        throw new ApiError(503, "github_unavailable", "GitHub could not be reached; try again");
      }
      if (read.visibility !== "public") throw new ApiError(422, "twin_repo_not_public", "a private twin is made for a public repo", [{ path: "id", code: "not_public" }]);
      if (typeof read.ownerGhId !== "number") throw new ApiError(503, "github_unavailable", "GitHub could not be reached; try again");
      return authorizeCreate(ctx.principal, {
        owner_gh_id: read.ownerGhId,
        name: valid.value.name,
        visibility: "private",
        description_sha256: descriptionHash(null),
        auto_init: false,
        purpose: "twin",
        twin_of: input.params.id!,
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/twin",
    operationId: "getRepoTwin",
    summary: "A public repo's live private twin, or null",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParams,
    extraResponses: { "503": "`not_configured`: private twins are not on yet." },
    responseSchema: z.object({ twin: twinSchema.nullable() }),
    async handler(ctx, input) {
      enabled();
      const twin = await getRepoTwin({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      return { twin: twin ? toItem(twin) : null };
    },
  },
  {
    method: "POST",
    path: "/api/v1/twins/{id}/pause",
    operationId: "pauseRepoTwin",
    summary: "Pause a twin: no publish or sync is issued while it is paused (the engine keeps working)",
    extraResponses: stateExtra,
    ...common,
    handler: (ctx, input) => change(ctx, input.params.id!, "pause"),
  },
  {
    method: "POST",
    path: "/api/v1/twins/{id}/resume",
    operationId: "resumeRepoTwin",
    summary: "Resume a paused twin",
    extraResponses: stateExtra,
    ...common,
    handler: (ctx, input) => change(ctx, input.params.id!, "resume"),
  },
  {
    method: "POST",
    path: "/api/v1/twins/{id}/check",
    operationId: "checkRepoTwinAgain",
    summary: "Check again: compare the twin and its public repo on the next sweep",
    description: "Owner or admin. Marks the twin's parity check due; the sweep compares the two repositories within a minute or two and the card's counts and state follow. Nothing is sent to GitHub by this call. Answers the twin as it reads now.",
    extraResponses: stateExtra,
    ...common,
    handler: async (ctx, input) => {
      enabled();
      try {
        return toItem(await checkRepoTwinAgain({ pool: ctx.pool, principal: ctx.principal }, input.params.id!));
      } catch (err) {
        if (err instanceof TwinStateError) throw new ApiError(409, "twin_state", `a twin that is ${err.state} cannot be checked again`, undefined, { state: err.state });
        throw err;
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/twins/{id}/merge",
    operationId: "mergeRepoTwinPr",
    summary: "Merge the twin's open publish pull request through the GitHub App",
    description:
      "Owner or admin; `{id}` is the twin. `pr` must be `publish`: the publish pull request on the public repo (the sync pull request is the engine's to merge, so a `sync` request is a validation error). The number and repository are the cloud's own records, never the request's. A publish pull request whose head the cloud has not recorded, or whose head moved, is `twin_pr_changed`. The App makes the merge as one squash at the head it just read, so a pull request that moved is refused. A pull request GitHub will not merge yet (a required check or review) is `twin_pr_blocked`: finish it on GitHub.",
    extraResponses: {
      "404": "`not_found`: no such twin.",
      "409": "`twin_state` (the twin is not ready, paused or in conflict; `data.state` is what it is), `twin_no_pr` (no such pull request is open), `twin_pr_changed` (it was closed or its head moved: look at it again) or `twin_pr_blocked` (GitHub will not merge it yet).",
      "503": "`not_configured` (private twins are not on yet, or no GitHub App) or `github_unavailable`.",
    },
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParams,
    bodySchema: mergeBody,
    responseSchema: z.object({ merged: z.boolean(), already: z.boolean(), pr: z.number().int() }),
    async handler(ctx, input) {
      enabled();
      assertRepoIdShape(input.params.id!);
      if (twinRouteDeps.mergePr === null) throw new ApiError(503, "not_configured", "merging is not available now");
      const out = await twinRouteDeps.mergePr({ accountId: ctx.principal.accountId, userId: ctx.principal.userId, twinId: input.params.id! });
      switch (out.result) {
        case "merged":
        case "already":
          return { merged: true, already: out.result === "already", pr: out.pr };
        case "not_found":
          throw new ApiError(404, "not_found", "no such twin");
        case "twin_state":
          throw new ApiError(409, "twin_state", `a twin that is ${out.state} cannot be merged into`, undefined, { state: out.state });
        case "no_open_pr":
          throw new ApiError(409, "twin_no_pr", "no such pull request is open on this twin");
        case "pr_changed":
          throw new ApiError(409, "twin_pr_changed", "the pull request was closed or changed on GitHub; look at it again");
        case "pr_blocked":
          throw new ApiError(409, "twin_pr_blocked", "GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again");
        default:
          throw new ApiError(503, "github_unavailable", "GitHub could not be reached; try again");
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/twins/{id}",
    operationId: "removeRepoTwin",
    summary: "Stop publishing: the twin ends here and the private repo stays on GitHub (it is never deleted)",
    extraResponses: stateExtra,
    ...common,
    handler: (ctx, input) => change(ctx, input.params.id!, "remove"),
  },
];
