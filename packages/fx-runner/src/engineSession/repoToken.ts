/**
 * D#845 ON-18: the refresh loop of a session's repo-scoped GitHub token. The runner asks the cloud (`engineRepoToken`, signed, once per ask) and hands the answer to the guest through `put` (`token_put github`, the guest keeps it
 * in one 0600 tmpfs file); the first ask comes shortly after the start's `done` (the cloud answers only once the session's lease is live, and the lease starts at the machine's next report), and every success schedules the
 * next ask 45 minutes on, well inside the token's hour. A failed ask (any refusal, an error, a guest that did not take the token) is tried again a minute later; THREE IN A ROW end the session: `exhausted` stops it with the
 * closed reason `token_refresh_failed`, and the loop is over. A stop, a delete or a newer start of the same repository ends the loop first (`end`, `begin`), so a late answer is never put into a session that is gone.
 * The token passes through one buffer that is zeroed after the put; the string the HTTP reply made cannot be (the same limit every route that hands a credential on has, which the guest's own exit-on-stop answers).
 * Nothing about a token, an error or the cloud's words is logged: the log line names the repository's id and the count.
 */
import type { RunnerClient } from "../daemon/client.js";

export const REPO_TOKEN_FIRST_MS = 15_000;
export const REPO_TOKEN_REFRESH_MS = 45 * 60_000;
export const REPO_TOKEN_RETRY_MS = 60_000;
export const REPO_TOKEN_MAX_FAILURES = 3;

export interface RepoTokenRefresher {
  /** Starts (or restarts) the loop of this repository's session; `put` hands one token to the guest. */
  begin(repoGhId: number, sessionId: string, put: (token: Buffer) => Promise<void>): void;
  /** Ends the loop of this repository, if any: a stop, a delete or a session that is over. */
  end(repoGhId: number): void;
}

export interface RepoTokenRefresherDeps {
  client: Pick<RunnerClient, "engineRepoToken" | "engineRepoTokenStop">;
  after: (ms: number, fn: () => void) => () => void;
  /** Three failed asks in a row, after the cloud was told (`engineRepoTokenStop`, best effort): the caller stops the session with `token_refresh_failed`. */
  exhausted: (repoGhId: number) => void;
  log: (line: string) => void;
  /** True while the latest answered hello accepted `repo_token_refresh_v1`. Left out, the loop always runs. Without it no loop starts, so a cloud that does not know the route never has a session stopped for it. */
  enabled?: () => boolean;
  /** Revokes one token at GitHub with the token itself; it never throws a cause. Left out, nothing is revoked and a token lapses at its hour. */
  revoke?: (token: string) => Promise<boolean>;
}

export function createRepoTokenRefresher(deps: RepoTokenRefresherDeps): RepoTokenRefresher {
  const loops = new Map<number, { cancel: () => void; held?: string }>();
  /** Best effort and never waited for: a token that cannot be revoked lapses at its hour. Only a fixed code is logged. */
  const revoke = (token: string | undefined): void => {
    if (token === undefined || deps.revoke === undefined) return;
    const failed = (): void => deps.log("fx-runner: a repository token could not be revoked (repo_token_revoke_failed)");
    deps.revoke(token).then((done) => done || failed(), failed); // the code is the whole record; nothing of the cause is kept
  };
  const end = (repoGhId: number): void => {
    const loop = loops.get(repoGhId);
    loop?.cancel();
    loops.delete(repoGhId);
    revoke(loop?.held); // the session is over (a stop, a delete or a restart of the loop): its current token goes
    if (loop !== undefined) delete loop.held;
  };
  return {
    end,
    begin(repoGhId, sessionId, put) {
      end(repoGhId);
      if (deps.enabled !== undefined && !deps.enabled()) return;
      const loop: { cancel: () => void; held?: string } = { cancel: () => undefined };
      loops.set(repoGhId, loop);
      const live = (): boolean => loops.get(repoGhId) === loop;
      const schedule = (ms: number, failures: number): void => {
        loop.cancel = deps.after(ms, () => void attempt(failures));
      };
      async function attempt(failures: number): Promise<void> {
        if (!live()) return;
        let ok = false;
        try {
          const got = await deps.client.engineRepoToken(repoGhId, sessionId);
          // a 404 that does not carry the route's own `not_found` is a cloud that has no such route (an older one): no strike, no stop, the loop just ends and the session keeps running
          if (got.kind === "refused" && got.status === 404 && got.code !== "not_found") {
            if (live()) {
              end(repoGhId);
              deps.log(`fx-runner: the cloud has no repository token route (repo_token_route_missing); repository ${repoGhId} keeps its session without a token refresh`);
            }
            return;
          }
          if (got.kind === "token" && !live()) revoke(got.token); // asked before a stop, answered after it: it is not kept
          if (got.kind === "token" && live()) {
            const buffer = Buffer.from(got.token, "latin1");
            try {
              try {
                await put(buffer);
              } catch (error) {
                revoke(got.token); // minted and never delivered: it is not kept
                throw error;
              }
              ok = true;
              // the new token is in the guest: the one it replaces goes
              const previous = loop.held;
              loop.held = got.token;
              revoke(previous);
            } finally {
              buffer.fill(0);
            }
          }
        } catch {
          // fx-swallow-ok: a failed ask is counted below, as one failure; nothing of its cause is kept or logged
          ok = false;
        }
        if (!live()) return;
        if (ok) return schedule(REPO_TOKEN_REFRESH_MS, 0);
        if (failures + 1 >= REPO_TOKEN_MAX_FAILURES) {
          end(repoGhId);
          deps.log(`fx-runner: the repository token of repository ${repoGhId} could not be refreshed ${REPO_TOKEN_MAX_FAILURES} times in a row; stopping its session (token_refresh_failed)`);
          // the cloud is told first, so its Team card can say why; a report that cannot be made never keeps the session from stopping
          const report = await deps.client.engineRepoTokenStop(repoGhId, sessionId).then((r) => r.kind === "reported", () => false);
          if (!report) deps.log(`fx-runner: the cloud could not be told why repository ${repoGhId} stopped (repo_token_stop_unreported)`);
          deps.exhausted(repoGhId);
          return;
        }
        schedule(REPO_TOKEN_RETRY_MS, failures + 1);
      }
      schedule(REPO_TOKEN_FIRST_MS, 0);
    },
  };
}
