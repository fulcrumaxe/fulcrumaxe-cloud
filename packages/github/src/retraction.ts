import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "./installationHttp.js";

/**
 * D#7 DP7b-w (C26 R2 item 3): the writes a deprecation-notice retraction needs on GitHub, one per surface the notice was recorded on. The
 * client (`installationHttp.ts` kind `retraction`) is pinned to that one surface and refuses everything else before a token is used;
 * this file is the caller that speaks to it and turns every answer into a fixed code. No GitHub text is passed on.
 *
 *   - `release`    read the release body, then append the correction (`PATCH /releases/<id>`, body only). Nothing is written when the body already holds it.
 *   - `comment`    one new comment on an issue or a pull request (`POST /issues/<n>/comments`).
 *   - `discussion` one `addDiscussionComment` mutation. It needs the App to hold `discussions: write`; while the installation does not, the answer is
 *                  `permission_missing` and no mutation is sent (GitHub refuses the token at mint time). Granting that permission is an owner action.
 */

export type RetractionSurface =
  | { kind: "release"; releaseId: number }
  | { kind: "comment"; number: number }
  | { kind: "discussion"; discussionId: string };

/** The one GraphQL document a `discussion` retraction may send. It appears nowhere else in the source. */
export const ADD_DISCUSSION_COMMENT_DOCUMENT =
  "mutation RetractNotice($discussionId: ID!, $body: String!) { addDiscussionComment(input: {discussionId: $discussionId, body: $body}) { comment { url } } }";

export type RetractionCode = "permission_missing" | "not_found" | "retraction_refused" | "no_installation" | "unavailable";
export type RetractionResult = { ok: true; url: string | null; unchanged: boolean } | { ok: false; code: RetractionCode };

export interface RetractionDeps {
  /** `createInstallationHttp(...)`: the client for one repository and (for `retraction`) one surface. */
  open: (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;
}
export interface RetractionRequest {
  repo: { id: string; owner: string; name: string };
  surface: RetractionSurface;
  /** The correction text. Plain text, not empty, at most 20000 characters. */
  text: string;
}

const fail = (code: RetractionCode): RetractionResult => ({ ok: false, code });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const urlOf = (v: unknown): string | null => (typeof v === "string" && v.startsWith("https://") ? v : null);

/** Maps a refused open (no installation, a mint GitHub refused, a token narrower than asked) to a fixed code, by the error's own `reason` and the mint's HTTP status, never its text. */
function openFailure(error: unknown): RetractionCode {
  const e = (isRecord(error) ? error : {}) as { reason?: unknown; cause?: unknown };
  if (e.reason === "no_installation") return "no_installation";
  if (e.reason === "token_scope_mismatch") return "permission_missing";
  const status = isRecord(e.cause) ? e.cause["status"] : undefined;
  return e.reason === "mint_failed" && (status === 403 || status === 422) ? "permission_missing" : "unavailable";
}

function graphqlFailure(body: unknown): RetractionCode {
  const errors = isRecord(body) && Array.isArray(body["errors"]) ? body["errors"] : [];
  const types = errors.map((x) => (isRecord(x) ? x["type"] : undefined));
  const text = errors.map((x) => (isRecord(x) && typeof x["message"] === "string" ? x["message"] : "")).join(" ");
  if (types.includes("FORBIDDEN") || /not accessible by integration/i.test(text)) return "permission_missing";
  if (types.includes("NOT_FOUND")) return "not_found";
  return errors.length > 0 ? "retraction_refused" : "unavailable";
}

function statusFailure(status: number): RetractionCode {
  if (status === 401 || status === 403) return "permission_missing";
  if (status === 404) return "not_found";
  if (status === 410 || status === 422) return "retraction_refused";
  return "unavailable";
}

export async function postRetraction(deps: RetractionDeps, req: RetractionRequest): Promise<RetractionResult> {
  if (typeof req.text !== "string" || req.text.trim() === "" || req.text.length > 20_000) return fail("retraction_refused");
  let http: InstallationHttp;
  try {
    http = await deps.open("retraction", { repoId: req.repo.id, owner: req.repo.owner, name: req.repo.name, retraction: req.surface });
  } catch (error) {
    // fx-swallow-ok: replaced by a fixed code; the original's text can carry anything the mint answered
    return fail(openFailure(error));
  }
  const base = `/repos/${req.repo.owner}/${req.repo.name}`;
  const s = req.surface;
  try {
    if (s.kind === "release") {
      const path = `${base}/releases/${s.releaseId}`;
      const current = await http.request({ method: "GET", path });
      if (current.status !== 200 || !isRecord(current.body)) return fail(statusFailure(current.status));
      const before = typeof current.body["body"] === "string" ? current.body["body"] : "";
      if (before.includes(req.text)) return { ok: true, url: urlOf(current.body["html_url"]), unchanged: true };
      const next = before === "" ? req.text : `${before}\n\n${req.text}`;
      const res = await http.request({ method: "PATCH", path, body: { body: next } });
      return res.status === 200 && isRecord(res.body) ? { ok: true, url: urlOf(res.body["html_url"]), unchanged: false } : fail(statusFailure(res.status));
    }
    if (s.kind === "comment") {
      const res = await http.request({ method: "POST", path: `${base}/issues/${s.number}/comments`, body: { body: req.text } });
      return res.status === 201 && isRecord(res.body) ? { ok: true, url: urlOf(res.body["html_url"]), unchanged: false } : fail(statusFailure(res.status));
    }
    const res = await http.request({ method: "POST", path: "/graphql", body: { query: ADD_DISCUSSION_COMMENT_DOCUMENT, variables: { discussionId: s.discussionId, body: req.text } } });
    if (res.status !== 200) return fail(statusFailure(res.status));
    const data = isRecord(res.body) && isRecord(res.body["data"]) ? res.body["data"] : null;
    const add = data !== null && isRecord(data["addDiscussionComment"]) ? data["addDiscussionComment"] : null;
    const comment = add !== null && isRecord(add["comment"]) ? add["comment"] : null;
    if (isRecord(res.body) && Array.isArray(res.body["errors"]) && res.body["errors"].length > 0) return fail(graphqlFailure(res.body));
    return comment !== null ? { ok: true, url: urlOf(comment["url"]), unchanged: false } : fail("unavailable");
  } catch {
    // fx-swallow-ok: a refused or failed request becomes a fixed code; the client's text can carry the request URL
    return fail("unavailable");
  } finally {
    await http.close?.();
  }
}
