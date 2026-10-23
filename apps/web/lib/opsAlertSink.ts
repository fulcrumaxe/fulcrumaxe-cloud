import type { OpsAlertSink } from "@fx/reconcile";

/**
 * D#6 STALL-ALERT-FAST: the one "ops alert" sink today, a comment on a GitHub issue (the ops log) in a repo chosen by environment.
 *
 *   FX_STALL_ALERT_REPO     owner/name of the repo holding the ops log issue
 *   FX_STALL_ALERT_ISSUE    the issue number
 *   FX_STALL_ALERT_TOKEN    a token allowed to comment on that issue (issues: write on that one repo)
 *   FX_STALL_ALERT_MENTION  optional handle to @-mention on a problem notice (not on a recovery notice)
 *
 * Any of the first three missing or malformed turns the sink off (null): alerts are simply not sent. Nothing here reads a database, and the text
 * it posts is built by the caller from fixed strings. A failed post throws a fixed message (never the response body or the token); the caller
 * keeps that off the database.
 */

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const HANDLE = /^@?[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9._-]{1,100})?$/;
export const OPS_ALERT_TIMEOUT_MS = 5_000;

export type OpsAlertFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function opsAlertSinkFromEnv(env: Record<string, string | undefined> = process.env, doFetch: OpsAlertFetch = fetch as unknown as OpsAlertFetch): OpsAlertSink | null {
  const repo = env.FX_STALL_ALERT_REPO?.trim() ?? "";
  const issue = env.FX_STALL_ALERT_ISSUE?.trim() ?? "";
  const token = env.FX_STALL_ALERT_TOKEN?.trim() ?? "";
  if (!REPO.test(repo) || !/^[1-9][0-9]{0,9}$/.test(issue) || token === "") return null;
  const rawMention = env.FX_STALL_ALERT_MENTION?.trim() ?? "";
  const mention = HANDLE.test(rawMention) ? (rawMention.startsWith("@") ? rawMention : `@${rawMention}`) : "";
  return {
    async send(notice) {
      const body = notice.kind !== "recovered" && mention !== "" ? `${mention} ${notice.text}` : notice.text;
      const res = await doFetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "fulcrumaxe-cloud-ops-alert",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(OPS_ALERT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ops alert sink: GitHub answered ${res.status}`);
    },
  };
}
