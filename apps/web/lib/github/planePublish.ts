import { createHash } from "node:crypto";
import type { WorkerPorts } from "@fx/worker";
import { readPlanePushIdentity } from "@fulcrumaxe/runner-protocol/planePushIdentity";
import { PLANE_PUBLISH_HOOK_SHA256, PLANE_PUBLISH_HOOK_SOURCE } from "../../app/_generated/plane-publish-hook";
import { createLivePlanePushPort } from "./planePushHosted";
import { createStackBasePort } from "@fx/pipeline";
import { createRepoTreeSource } from "@fx/github";
import { createAppContinuationBase, createAppRunPullRequestPort } from "./runnerPullRequest";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#598 P1f-5b: the live side of the worker's paired-publish step. Four things come from outside the worker:
 *  - the hook: the built `fx-plane-publish.mjs`, compiled into the server build as text by `scripts/build-plane-publish.mjs` (never read from a path);
 *  - the commit identity: the two hosted settings the runner's token route already uses, read per call so a fixed setting takes effect at once;
 *  - the private branch's head, from GitHub, through the same read a continuation's base uses, and the default branch's head (where the publish rules are read);
 *  - the hosted reads of the public repo (branch, parent, pull request), each with its own short-lived token (`createLivePlanePushPort`).
 * An App that is not configured makes the hosted reads throw `not_configured`; the step shows that as the fixed `public_unavailable` refusal.
 */
export function createPlanePublishPorts(env: NodeJS.ProcessEnv = process.env): NonNullable<WorkerPorts["planePublish"]> {
  const base = createAppContinuationBase();
  const hosted = createLivePlanePushPort(env);
  return {
    hook: () => {
      // The text that goes into a sandbox is checked against the hash the build recorded for it (a corrupted or substituted bundle fails the attempt, which shows as a crash refusal).
      if (createHash("sha256").update(PLANE_PUBLISH_HOOK_SOURCE).digest("hex") !== PLANE_PUBLISH_HOOK_SHA256) throw new Error("plane publish hook: the built text does not match its recorded hash");
      return PLANE_PUBLISH_HOOK_SOURCE;
    },
    identity: () => {
      const r = readPlanePushIdentity(env);
      return r.ok ? r.identity : null;
    },
    privateHead: ({ repo, branch }) => base.headOid({ repo, branch }),
    // The default branch's head, through the read-only `repo_map` token the build's recorded base is read with.
    privateDefaultHead: async ({ repo }) => createRepoTreeSource(await openInstallationHttp("repo_map", { repoId: repo.id, owner: repo.owner, name: repo.name }), { owner: repo.owner, name: repo.name }).headSha(),
    hosted: { verifyPushed: (i) => hosted.verifyPushed(i), verifyPullRequest: (i) => hosted.verifyPullRequest(i), openPullRequest: (i) => hosted.openPullRequest(i), branchHead: (i) => hosted.branchHead(i) },
    // D#598 P1f-5c: the private pull request is opened the way a runner run's `done` opens it (the same port and token kind), and a stacked item's goes against its parent's branch.
    pullRequests: createAppRunPullRequestPort(),
    stackBase: createStackBasePort({ open: (kind, r) => openInstallationHttp(kind, { repoId: r.repoId, owner: r.owner, name: r.name }) }),
  };
}
