import type { Pool } from "pg";
import { createRepoTreeSource, liveInstallationTokens } from "@fx/github";
import { createPgRepoMapCache, createPinContentPort, createRepoMapPort, createStackBasePort, startBuildForItem, type StartBuildOptions } from "@fx/pipeline";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#600 CX-3a: the stage driver's build step with the repository map. The map is read from GitHub with a one-repository `repo_map`
 * token (metadata and contents, read only, an exact path list), cached in Postgres per repository, and handed to the prompt assembler.
 * A failure of any part leaves the map out and the build starts without it.
 */
/** The composition root supplies the live-secrets source itself, so its callers pass the rest of the options only. */
export function createBuildWithRepoMap(open: typeof openInstallationHttp = openInstallationHttp): (pool: Pool, accountId: string, workItemId: string, approvalId: string, ports: Parameters<typeof startBuildForItem>[4], options?: Omit<StartBuildOptions, "liveSecrets">) => ReturnType<typeof startBuildForItem> {
  return (pool: Pool, accountId, workItemId, approvalId, ports, options = {}) =>
    startBuildForItem(pool, accountId, workItemId, approvalId, ports, {
      ...options,
      // D#601 MEM-RECALL-RESCAN: recalled memory is checked against the installation tokens this process holds live, the source the memory export uses.
      liveSecrets: () => liveInstallationTokens(),
      repoMap: createRepoMapPort({
        cache: createPgRepoMapCache(pool),
        open: async (r) => createRepoTreeSource(await open("repo_map", { repoId: r.repoId, owner: r.owner, name: r.name }), { owner: r.owner, name: r.name }),
        log: (reason) => console.info(JSON.stringify({ event: "advance.repo_map_skipped", reason })),
      }),
      // D#600 CX-5b: the files a person pinned, read with the same one-repository token (trees at the start commit, then blobs by id). A pin that cannot be read is skipped and counted in the run's ledger.
      pins: createPinContentPort({
        open: async (r) => createRepoTreeSource(await open("repo_map", { repoId: r.repoId, owner: r.owner, name: r.name }), { owner: r.owner, name: r.name }),
        log: (reason) => console.info(JSON.stringify({ event: "advance.pins_skipped", reason })),
      }),
      // D#598 P3b: an item with a stack parent reads the parent's open pull request and branch tip (read-only tokens) before its run starts.
      // D#598 P1f-5c: a paired repository's build records the default branch's head as its base (read-only `repo_map` token, the map's own read).
      planeBase: { defaultHead: async (r) => createRepoTreeSource(await open("repo_map", r), { owner: r.owner, name: r.name }).headSha() },
      stackBase: createStackBasePort({ open: (kind, r) => open(kind, { repoId: r.repoId, owner: r.owner, name: r.name }) }),
    });
}
