import type { Pool } from "pg";
import { parseReceivePackRefUpdates } from "@fx/gh-policy";

/**
 * D#519 MQ4-b0: records the branch pushes the gh-proxy forwarded, so the merge queue can prove a commit is the platform's own. Called only after GitHub
 * answered a receive-pack 200 (a rejected ref update in that answer still names a commit our run built, so it is recorded too). Each ref update in the
 * body becomes one call to `record_platform_ref_push` (migration 0956) on the narrow gh-proxy login; the database takes everything about the run from
 * the run's own row, so the only facts sent are the run's key (the verified sandbox name or ticket run id) and the ref, old and new ids.
 *
 * A body that does not parse whole records nothing. A database error rejects, and the caller logs its class only: a push is never failed or changed by a
 * record, and a commit with no record reads as foreign later (fail closed).
 */
export type PlatformPushKey = { sandboxName: string } | { runId: string };
export type PlatformPushRecorder = (key: PlatformPushKey, receivePackBody: Uint8Array) => Promise<void>;

const QUERY = "SELECT public.record_platform_ref_push($1, $2, $3, $4, $5) AS recorded";

export function createPlatformPushRecorder(ghProxyPool: Pool): PlatformPushRecorder {
  return async function recordPlatformPushes(key, receivePackBody) {
    const parsed = parseReceivePackRefUpdates(receivePackBody);
    if (!parsed.complete) return;
    const sandboxName = "sandboxName" in key ? key.sandboxName : null;
    const runId = "runId" in key ? key.runId : null;
    for (const u of parsed.updates) {
      if (!u.ref.startsWith("refs/heads/")) continue;
      await ghProxyPool.query(QUERY, [sandboxName, runId, u.ref, u.old, u.new]);
    }
  };
}
