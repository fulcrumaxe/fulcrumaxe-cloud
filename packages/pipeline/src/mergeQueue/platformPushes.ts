import type { PoolClient } from "pg";
import type { PlatformCommitProofReader, PlatformPush } from "./conflict.js";

/**
 * D#519 MQ4-b0: the production proof reader. The push records the gh-proxy wrote (migration 0956) whose new tip is one of the pull request's commits,
 * read in the entry's own tenant and repository, plus the repository's app login for rule (b). An empty sha list is the probe ("can the proof be
 * read?"): it answers readable with no query and no login read. No GitHub read is made here except the app login, which `appLogin` serves from the same
 * cached lookup the tick already makes; a login that cannot be read is null, so only push records count.
 */
export interface PlatformPushReaderDeps {
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  appLogin(repoId: string): Promise<string>;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function createPlatformPushReader(deps: PlatformPushReaderDeps): PlatformCommitProofReader {
  return async (entry, shas) => {
    if (shas.length === 0) return { appLogin: null, pushes: [] };
    const wanted = [...new Set(shas.filter((s) => SHA.test(s)))];
    const rows = await deps.inTenant(entry.accountId, async (c) =>
      (
        await c.query<{ old_sha: string | null; new_sha: string; start_sha: string | null; run_id: string }>(
          `SELECT old_sha, new_sha, start_sha, run_id FROM platform_ref_pushes WHERE account_id = $1 AND repo_id = $2 AND new_sha = ANY($3::text[])`,
          [entry.accountId, entry.repoId, wanted],
        )
      ).rows,
    );
    const pushes: PlatformPush[] = rows.map((r) => ({ oldSha: r.old_sha, newSha: r.new_sha, startSha: r.start_sha, runId: r.run_id }));
    let appLogin: string | null = null;
    try {
      appLogin = await deps.appLogin(entry.repoId);
    } catch {
      // fx-swallow-ok: without the app's login only push records count (rule b is skipped); that fails closed
      appLogin = null;
    }
    return { appLogin, pushes };
  };
}
