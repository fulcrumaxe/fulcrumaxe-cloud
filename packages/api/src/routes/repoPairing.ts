import { z } from "zod";
import { clearRepoPairing, getRepoPairing, listPairingCandidates, MAX_OVERLAY_GLOBS, setRepoPairing, validatePairingInput, type RepoPairing } from "@fx/core/src/repos/pairing.js";
import type { RouteEntry } from "../registry.js";
import { ApiError } from "../errors.js";
import { SESSION_LIMITS } from "../ratelimit/session.js";

/** What the pairing screens may ask GitHub about a public repo (the production reader is `createPublicRepoInspector` in @fx/github). */
export interface PairingRepoInspector {
  /**
   * Facts about one repo for the caller's account. `appInstalled` is true only when the repo is public and the CALLER's own write-App installation
   * serves it; a repo that is not public (private or missing) reads as `not_public`. `hint` is an installation of this account already known to serve it.
   */
  inspect(
    codeRepo: string,
    accountId: string,
    opts?: { hint?: { installationId: number; appKind: "team" | "team_readonly" }; signal?: AbortSignal },
  ): Promise<{ visibility: "public" | "not_public"; defaultBranch: string | null; appInstalled: boolean }>;
}

/** Set by the app (the `/api/v1` catch-all). With none, the routes that must ask GitHub answer 503 and the read reports the install state as unknown. */
export const repoPairingDeps: { getInspector: () => PairingRepoInspector | null } = { getInspector: () => null };

const CANDIDATE_BATCH = 5;
/** One deadline for the whole picker list, well under the function's 30 s limit. */
const PICKER_DEADLINE_MS = 18_000;

/** A reader failure becomes one fixed 503 (the error to throw); the reader's own text is never passed on. */
function inspectCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "PublicRepoInspectError" ? (err as { code?: unknown }).code : undefined;
}

function inspectFailure(err: unknown): unknown {
  const code = inspectCode(err);
  if (code === "not_configured") return new ApiError(503, "github_app_not_configured", "the GitHub App is not configured");
  if (code === "github_unavailable" || code === "installation_unusable") return new ApiError(503, "github_unavailable", "GitHub could not be reached; try again");
  if (code === "repo_renamed") return new ApiError(422, "code_repo_renamed", "that repo has been renamed; use its current name", [{ path: "code_repo", code: "renamed" }]);
  return err;
}

const pairingResponseSchema = z.object({
  /** False when the repo has no pairing row: the default, and what a repo that never opted in reads as. */
  enabled: z.boolean(),
  code_repo: z.string().nullable(),
  overlay_globs: z.array(z.string()),
  identifier_rules_path: z.string().nullable(),
  plan_data_rules_path: z.string().nullable(),
  /** The public pull request body footer template; null when none (the default). */
  pr_footer: z.string().nullable(),
  /** Whether the GitHub App is installed on the paired public repo; null when not paired or when GitHub could not say just now. */
  code_repo_app_installed: z.boolean().nullable(),
});

const candidatesResponseSchema = z.object({
  data: z.array(
    z.object({
      full_name: z.string(),
      visibility: z.literal("public"),
      /** A plain branch name, or null when GitHub's name was not one (never `main`). */
      default_branch: z.string().nullable(),
      app_installed: z.boolean(),
    }),
  ),
  /** True when the account has more installed repos than were looked at. */
  truncated: z.boolean(),
});

const repoIdParamsSchema = z.object({ id: z.string() });

/** Strict, and a full replace: an unknown key is a 422. Both rule-file paths are optional; omitted or null means none declared. */
const putPairingBodySchema = z
  .object({
    code_repo: z.string(),
    overlay_globs: z.array(z.string()).max(MAX_OVERLAY_GLOBS),
    identifier_rules_path: z.string().nullable().optional(),
    plan_data_rules_path: z.string().nullable().optional(),
    pr_footer: z.string().nullable().optional(),
  })
  .strict();

function toItem(p: RepoPairing, installed: boolean | null = null): z.infer<typeof pairingResponseSchema> {
  return {
    code_repo_app_installed: p.enabled ? installed : null,
    enabled: p.enabled,
    code_repo: p.codeRepo,
    overlay_globs: p.overlayGlobs,
    identifier_rules_path: p.identifierRulesPath,
    plan_data_rules_path: p.planDataRulesPath,
    pr_footer: p.prFooter ?? null,
  };
}

/** Repo pairing: read (member), set and clear (owner/admin, session only: a token may never change where code is pushed). */
export const repoPairingRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/pairing",
    operationId: "getRepoPairing",
    summary: "A repo's paired public code repo, or enabled false when it has none",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema: pairingResponseSchema,
    sessionLimit: SESSION_LIMITS.pairingGithub,
    async handler(ctx, input) {
      const pairing = await getRepoPairing({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      const inspector = repoPairingDeps.getInspector();
      let installed: boolean | null = null;
      if (pairing.enabled && pairing.codeRepo && inspector) {
        try {
          // Null for a repo that is not public (an old row), and for anything GitHub could not say; true only for the caller's own installation.
          const facts = await inspector.inspect(pairing.codeRepo, ctx.principal.accountId);
          installed = facts.visibility === "public" ? facts.appInstalled : null;
        } catch {
          // fx-swallow-ok: the install state is extra; when GitHub cannot say, the read still answers and reports it as unknown (null)
          installed = null;
        }
      }
      return toItem(pairing, installed);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/pairing",
    operationId: "putRepoPairing",
    summary: "Pair a repo with a public code repo, or replace its pairing (changes only items started afterwards)",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    sessionLimit: SESSION_LIMITS.pairingGithub,
    extraResponses: {
      "422": "`code_repo_not_public` (private or missing: the same answer for both), `code_repo_renamed` (use the repo's current name), or `public_default_branch_not_main` (`data.branch` is the branch name, null when it is not a plain branch name). Other 422s are `invalid_role_settings_input` with the field in `details`.",
      "503": "`github_unavailable` or `github_app_not_configured`: the public repo could not be checked, so nothing was saved.",
    },
    paramsSchema: repoIdParamsSchema,
    bodySchema: putPairingBodySchema,
    responseSchema: pairingResponseSchema,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof putPairingBodySchema>;
      const svc = { pool: ctx.pool, principal: ctx.principal };
      const set = {
        codeRepo: body.code_repo,
        overlayGlobs: body.overlay_globs,
        identifierRulesPath: body.identifier_rules_path,
        planDataRulesPath: body.plan_data_rules_path,
        prFooter: body.pr_footer,
      };
      // Nothing goes to GitHub for a bad shape or for a repo that is not the caller's (a 404 here).
      validatePairingInput(set);
      await getRepoPairing(svc, input.params.id!);
      const inspector = repoPairingDeps.getInspector();
      if (!inspector) throw new ApiError(503, "github_app_not_configured", "the GitHub App is not configured");
      let facts;
      try {
        facts = await inspector.inspect(body.code_repo, ctx.principal.accountId);
      } catch (err) {
        throw inspectFailure(err);
      }
      // The same answer for a private repo and a missing one: nothing says which, or whether anyone has the App installed there.
      if (facts.visibility !== "public") {
        throw new ApiError(422, "code_repo_not_public", "the paired repo must be a public repo that exists", [{ path: "code_repo", code: "not_public" }]);
      }
      if (facts.defaultBranch !== "main") {
        throw new ApiError(422, "public_default_branch_not_main", "only a public repo whose default branch is main can be paired", [{ path: "code_repo", code: "default_branch_not_main" }], { branch: facts.defaultBranch });
      }
      return toItem(await setRepoPairing(svc, input.params.id!, set), facts.appInstalled);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/repos/{id}/pairing",
    operationId: "deleteRepoPairing",
    summary: "Remove a repo's pairing; new items use the single-repo path and public PRs already open stay open",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: repoIdParamsSchema,
    responseSchema: z.null(),
    successStatus: 204,
    async handler(ctx, input) {
      await clearRepoPairing({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      return null;
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/pairing/candidates",
    operationId: "listPairingCandidates",
    summary: "The account's other installed repos that are public, with default branch and whether the App is installed, for the pairing picker",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    sessionLimit: SESSION_LIMITS.pairingPicker,
    extraResponses: { "503": "`github_unavailable` or `github_app_not_configured`: GitHub could not be asked, so no list is given." },
    paramsSchema: repoIdParamsSchema,
    responseSchema: candidatesResponseSchema,
    async handler(ctx, input) {
      const { candidates, truncated } = await listPairingCandidates({ pool: ctx.pool, principal: ctx.principal }, input.params.id!);
      const inspector = repoPairingDeps.getInspector();
      if (!inspector) throw new ApiError(503, "github_app_not_configured", "the GitHub App is not configured");
      const data: z.infer<typeof candidatesResponseSchema>["data"] = [];
      const signal = AbortSignal.timeout(PICKER_DEADLINE_MS);
      try {
        for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH) {
          const batch = candidates.slice(i, i + CANDIDATE_BATCH);
          const facts = await Promise.all(
            batch.map(async (c) => {
              try {
                return await inspector.inspect(c.fullName, ctx.principal.accountId, { hint: { installationId: c.installationId, appKind: c.appKind }, signal });
              } catch (err) {
                // A candidate whose stored installation GitHub refuses (suspended or gone) cannot be read: it is left out, the rest are listed.
                if (inspectCode(err) === "installation_unusable") return null;
                const mapped = inspectFailure(err);
                // A name our rows hold that GitHub says was renamed is left out of the list; it cannot be paired by that name.
                if (mapped instanceof ApiError && mapped.code === "code_repo_renamed") return null;
                throw mapped;
              }
            }),
          );
          facts.forEach((f, j) => {
            if (f && f.visibility === "public") data.push({ full_name: batch[j]!.fullName, visibility: "public", default_branch: f.defaultBranch, app_installed: f.appInstalled });
          });
        }
      } catch (err) {
        throw inspectFailure(err);
      }
      return { data, truncated };
    },
  },
];
