import type { Pool } from "pg";
import { createRepoTreeSource } from "@fx/github";
import { createPgRepoMapCache, createRepoMapPort, createStackBasePort, startBuildForItem } from "@fx/pipeline";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#600 CX-3a: the stage driver's build step with the repository map. The map is read from GitHub with a one-repository `repo_map`
 * token (metadata and contents, read only, an exact path list), cached in Postgres per repository, and handed to the prompt assembler.
 * A failure of any part leaves the map out and the build starts without it.
 */
export function createBuildWithRepoMap(open: typeof openInstallationHttp = openInstallationHttp): typeof startBuildForItem {
  return (pool: Pool, accountId, workItemId, approvalId, ports, options = {}) =>
    startBuildForItem(pool, accountId, workItemId, approvalId, ports, {
      ...options,
      repoMap: createRepoMapPort({
        cache: createPgRepoMapCache(pool),
        open: async (r) => createRepoTreeSource(await open("repo_map", { repoId: r.repoId, owner: r.owner, name: r.name }), { owner: r.owner, name: r.name }),
        log: (reason) => console.info(JSON.stringify({ event: "advance.repo_map_skipped", reason })),
      }),
      // D#598 P3b: an item with a stack parent reads the parent's open pull request and branch tip (read-only tokens) before its run starts.
      stackBase: createStackBasePort({ open: (kind, r) => open(kind, { repoId: r.repoId, owner: r.owner, name: r.name }) }),
    });
}
