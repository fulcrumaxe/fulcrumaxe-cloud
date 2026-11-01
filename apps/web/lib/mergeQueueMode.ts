import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort, MERGE_QUEUE_MODE_CACHE_MAX, MERGE_QUEUE_MODE_TTL_MS, type GitHubHttp } from "@fx/pipeline";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT } from "@fx/github";
import type { MergeQueueModeReader } from "@fx/api/src/routes/mergeQueueMode.js";
import { openInstallationHttp } from "./github/installationHttp";

/**
 * D#694 B7-2: the Repos screen's "Merge queue" line. The default branch, then the merge port's own
 * `getMergeQueueMode` (one pinned GraphQL read and the branch's rules, and the same agreement rule the merge gate uses) through the hosted `read` client.
 * The port's process-wide cache is the only cache of the mode answer, so the line is never older than that cache's five minutes and a second read inside
 * them makes no GitHub call. This reader keeps only the default-branch lookup (five minutes, at most 500 repositories, oldest out).
 * An answer the port could not give (an error, a disagreement, a permission refusal) is `unreadable`, is never cached, and is read again next time.
 * A `runner_local` repository is `unreadable`: its merge belongs to the customer's runner, and the fenced client cannot read the queue.
 */
export function createMergeQueueModeReader(pool: Pool, open: typeof openInstallationHttp = openInstallationHttp, now: () => number = Date.now): MergeQueueModeReader {
  const branches = new Map<string, { at: number; branch: string }>();
  return {
    async read({ accountId, repoId }) {
      const t = now();
      const repo = await withTenant(pool, accountId, async (c) =>
        (await c.query<{ gh_owner: string | null; gh_name: string | null; execution_mode: string }>(`SELECT gh_owner, gh_name, execution_mode FROM repos WHERE account_id = $1 AND id = $2`, [accountId, repoId])).rows[0],
      );
      if (!repo?.gh_owner || !repo.gh_name || repo.execution_mode === "runner_local") return "unreadable";
      const owner = repo.gh_owner;
      const name = repo.gh_name;
      const http = await open("read", { repoId, owner, name });
      try {
        let branch: string;
        const known = branches.get(repoId);
        if (known !== undefined && t >= known.at && t - known.at < MERGE_QUEUE_MODE_TTL_MS) branch = known.branch;
        else {
          branches.delete(repoId);
          const info = await http.request({ method: "GET", path: `/repos/${owner}/${name}` });
          const found = typeof info.body === "object" && info.body !== null ? (info.body as { default_branch?: unknown }).default_branch : undefined;
          if (info.status !== 200 || typeof found !== "string" || found === "") return "unreadable";
          branch = found;
          if (branches.size >= MERGE_QUEUE_MODE_CACHE_MAX) branches.delete(branches.keys().next().value as string);
          branches.set(repoId, { at: t, branch });
        }
        const port = createGitHubMergeGatePort({
          http: http as GitHubHttp,
          resolveRepo: async () => ({ owner, name }),
          markReadyForHumanMerge: async () => undefined,
          queueDocuments: { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT },
          now,
        });
        // The mode read names no pull request; the port only wants a valid reference to build the repository path from (it makes no pull request call here).
        const mode = await port.getMergeQueueMode!({ repoId, prNumber: 1 }, branch);
        if (mode.mode === "unknown") return "unreadable";
        return mode.mode === "queue" ? "on" : "off";
      } finally {
        await http.close?.();
      }
    },
  };
}
