import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "./installationHttp.js";

/**
 * D#7 DP7-2w: opens a draft pull request that reverts ONE merged pull request, with GitHub's own revert mutation, through a `revert_pr` client
 * (`installationHttp.ts`). This file is the only place the mutation is named: the client imports the pinned document from here and refuses any other.
 *
 * The sequence is fixed: read the pull request (`GET /pulls/<n>`: it must be merged, and its node id is the mutation's input), then send the mutation once.
 * Results are a pull request number and url, or a fixed code; no text from GitHub is ever copied into a result.
 *   not_merged (open, or closed unmerged: nothing sent), revert_refused (conflict or unprocessable: HTTP 200 with `errors`, or 422), pr_unreadable (no read, no node id),
 *   unavailable (no installation, a mint refusal, a transport failure, another status, a wrong shape).
 */
export type OpenRevertPullRequestCode = "not_merged" | "revert_refused" | "pr_unreadable" | "unavailable";
export type OpenRevertPullRequestResult = { ok: true; number: number; url: string } | { ok: false; code: OpenRevertPullRequestCode };

export interface OpenRevertPullRequestDeps {
  open: (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;
}

/** The one document a `revert_pr` client may send. */
export const REVERT_PR_DOCUMENT =
  "mutation($pullRequestId: ID!, $draft: Boolean!, $title: String!, $body: String!) { revertPullRequest(input: { pullRequestId: $pullRequestId, draft: $draft, title: $title, body: $body }) { revertPullRequest { number url } } }";
/** Fixed text: no item content in the revert's title or body. */
export const REVERT_PR_TITLE = "Revert a merged pull request";
export const REVERT_PR_BODY = "Opened by the platform to undo a merged change. Review it like any other pull request before merging.";

/** The variables a `revert_pr` client accepts: the pinned pull request's node id and the fixed text, as a draft. */
export function revertPrVariables(pullRequestId: string): Record<string, unknown> {
  return { pullRequestId, draft: true, title: REVERT_PR_TITLE, body: REVERT_PR_BODY };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/;

export async function openRevertPullRequest(deps: OpenRevertPullRequestDeps, input: { repo: { id: string; owner: string; name: string }; prNumber: number }): Promise<OpenRevertPullRequestResult> {
  const { repo, prNumber } = input;
  let http: InstallationHttp;
  try {
    http = await deps.open("revert_pr", { repoId: repo.id, owner: repo.owner, name: repo.name, prNumber });
  } catch {
    // fx-swallow-ok: a refusal to open (no installation, mint refused, bad coordinates) is one fixed code; its text is never passed on
    return { ok: false, code: "unavailable" };
  }
  try {
    const pull = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}` });
    if (pull.status !== 200 || !isObj(pull.body) || typeof pull.body["merged"] !== "boolean") return { ok: false, code: "pr_unreadable" };
    if (pull.body["merged"] !== true) return { ok: false, code: "not_merged" };
    const nodeId = pull.body["node_id"];
    if (typeof nodeId !== "string" || !/^[A-Za-z0-9_=-]{4,100}$/.test(nodeId)) return { ok: false, code: "pr_unreadable" };
    const res = await http.request({ method: "POST", path: "/graphql", body: { query: REVERT_PR_DOCUMENT, variables: revertPrVariables(nodeId) } });
    if (res.status === 422) return { ok: false, code: "revert_refused" };
    if (res.status !== 200 || !isObj(res.body)) return { ok: false, code: "unavailable" };
    if (Array.isArray(res.body["errors"]) && res.body["errors"].length > 0) return { ok: false, code: "revert_refused" };
    const data = res.body["data"];
    const payload = isObj(data) && isObj(data["revertPullRequest"]) ? data["revertPullRequest"] : undefined;
    const made = payload !== undefined && isObj(payload["revertPullRequest"]) ? payload["revertPullRequest"] : undefined;
    if (made === undefined) return { ok: false, code: "unavailable" };
    const number = made["number"];
    const url = made["url"];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || typeof url !== "string" || !URL_RE.test(url)) return { ok: false, code: "unavailable" };
    return { ok: true, number, url };
  } catch {
    // fx-swallow-ok: a refused request or a transport failure is one fixed code; the error's text can carry request details
    return { ok: false, code: "unavailable" };
  } finally {
    await http.close?.();
  }
}
