import { z } from "zod";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { GithubIdentityForbidden, GithubIdentityRepoNotFound, readRepoIdentityView, setRepoGithubIdentity } from "@fx/db/src/repoGithubIdentity.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError, NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { engineSettingsDeps } from "./engine.js";

/**
 * D#845 ON-19a: a project's GitHub identity, `app` (the default) or `personal` (the engine acts as the person on GitHub). The setting is stored and nothing more: the token never
 * reaches the cloud, and the runner side is a later row.
 *
 * Who: a PERSON, an owner or admin, on a session. The write names `principals: ["session"]`, so an API token is refused (403) before the handler runs; the database checks the same
 * again inside the definer function of migration 1121. A repo of another account answers 404. `personal` is refused on a public repo (409 `personal_identity_public_repo`), and
 * when GitHub does not say (409 `repo_visibility_unknown`): visibility is asked live and never remembered. Each real change writes `project.github_identity_changed` in the same transaction.
 */

const idParams = z.object({ id: z.string() });
const identity = z.enum(["app", "personal"]);
const view = z.object({
  github_identity: identity,
  /** The name the person gave the machine that serves the repo, for the confirm text; null when none is known. */
  machine: z.string().nullable(),
});

/** One GitHub visibility question, failing closed: a missing reader, or one that throws or rejects, reads as "unknown" (the seam is the settings routes', registered by production). */
async function visibilityOf(accountId: string, repoId: string): Promise<"private" | "public" | "unknown"> {
  try {
    const ask = engineSettingsDeps.getVisibility?.();
    return ask ? await ask(accountId, repoId) : "unknown";
  } catch {
    // fx-swallow-ok: any failure of the GitHub read is the same answer, "unknown", which the caller refuses
    return "unknown";
  }
}

export const repoGithubIdentityRoutes: RouteEntry[] = [
  {
    method: "GET", path: "/api/v1/repos/{id}/github-identity", operationId: "getRepoGithubIdentity",
    summary: "A project's GitHub identity (`app` or `personal`) and the name of the machine that serves it",
    principals: ["session", "token"], scope: "read", minRole: "member", idempotency: "never", rateClass: "read",
    paramsSchema: idParams, responseSchema: view,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const found = await withTenant(ctx.pool, accountId, userId, (client) => readRepoIdentityView(client, accountId, repoId));
      if (!found) throw new NotFoundError("repo not found");
      return found;
    },
  },
  {
    method: "PUT", path: "/api/v1/repos/{id}/github-identity", operationId: "setRepoGithubIdentity",
    summary: "Switch a project's GitHub identity (an owner or admin, on a session)",
    description: "`personal` is refused on a public repo with 409 `personal_identity_public_repo`, and with 409 `repo_visibility_unknown` when GitHub does not say. A real change writes `project.github_identity_changed`; a repeat writes nothing. Owner or admin, session only: no API token.",
    extraResponses: { "409": "The repo is public (`personal_identity_public_repo`), or GitHub did not say whether it is (`repo_visibility_unknown`)." },
    principals: ["session"], minRole: "admin", idempotency: "never", rateClass: "write",
    paramsSchema: idParams, bodySchema: z.object({ github_identity: identity }).strict(), responseSchema: view,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const want = (input.body as { github_identity: z.infer<typeof identity> }).github_identity;
      const { accountId, userId } = ctx.principal;
      // The repo must be the account's before GitHub is asked about it.
      if (!(await withTenant(ctx.pool, accountId, userId, (client) => readRepoIdentityView(client, accountId, repoId)))) throw new NotFoundError("repo not found");
      if (want === "personal") {
        const seen = await visibilityOf(accountId, repoId);
        if (seen === "public") throw new ApiError(409, "personal_identity_public_repo", "A personal GitHub identity can't be used on a public repo. Keep the fulcrumaxe app for this one.");
        if (seen !== "private") throw new ApiError(409, "repo_visibility_unknown", "GitHub didn't say whether that repository is public or private. Try again in a minute");
      }
      try {
        await withTenant(ctx.pool, accountId, userId, async (client) => {
          const r = await setRepoGithubIdentity(client, repoId, want);
          if (r.changed) await writeEngineAudit(client, "project.github_identity_changed", { repo_id: repoId, github_identity: want });
        });
      } catch (error) {
        if (error instanceof GithubIdentityRepoNotFound) throw new NotFoundError("repo not found");
        if (error instanceof GithubIdentityForbidden) throw new ForbiddenError("only an owner or admin can change the GitHub identity");
        throw error;
      }
      return (await withTenant(ctx.pool, accountId, userId, (client) => readRepoIdentityView(client, accountId, repoId)))!;
    },
  },
];
