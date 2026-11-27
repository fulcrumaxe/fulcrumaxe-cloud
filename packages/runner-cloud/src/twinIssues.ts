import type { PoolClient } from "pg";
import { reportError } from "@fx/telemetry";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { RunnerCloudDeps } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { BROUGHT_ISSUE_BODY_MAX } from "./localOnlyGithub.js";
import { RunPullRequestError, type PullRequestRepo } from "./runPullRequest.js";
import { readRepoVisibility } from "./repoPrivacy.js";

/**
 * D#845 ON-27f: "Bring this issue into the private repo". The twin card lists the OPEN issues of the public repository (the newest 20, no pull requests: number, title, author login, read through the App) and an owner or admin brings one
 * into the private twin. The repositories come from OUR rows (`repo_twins`, `repos`), never from the request, which names the twin and one issue number.
 *
 * What a bring does: reads that one issue (title and body, nothing else: no comments, no attachments), and opens an issue in the private repository with the same title, the label `from-public`, and a body that is a fixed header
 * (who brought it and that the text is the public author's and untrusted) followed by the original text. The original text is written INERT: inside a fenced code block that sits in a quotation (every line starts with `> `), with a fence longer
 * than any run of backticks in it, so a mention, an issue reference, a link, HTML or a heading in it never pings anyone or renders; the whole body is at most 65,536 characters and a cut is marked. The person's name and the author's login are cleaned to plain
 * letters and digits first. The public repository is READ through the read-only client; the one write goes through the `twin_issue` client (issues write on the private repository only, one POST, revoked at once).
 *
 * Once per public issue, claim first (migration 1118): `twin_issue_claim` takes the pair for five minutes BEFORE GitHub is asked, so only its winner creates the issue; `twin_issue_record` then sets the number and writes the one `twin.issue_brought` audit row. A second click answers `already` with the number (no GitHub call), or `in_progress` while a live claim has none. A claim that stops short (a refusal, a GitHub failure) is released at once; one that cannot be released lapses after five minutes.
 * Before anything is written into the private repository, its visibility is read live, for every state this accepts, a paused twin included: a private repository that turned public is refused (`not_private`, and the twin goes `refused`), and one that cannot be read is `visibility_unknown`; neither writes.
 * The write to GitHub cannot be undone by us, so once it is made the answer is `ok` whatever the record does: a record that throws or answers anything but `ok` or `already` is reported under one fixed class (`twin.issue_record_failed`, no text).
 */
export interface TwinIssueItem { number: number; title: string; author: string; brought: number | null }
export type TwinIssueList =
  | { result: "ok"; issues: TwinIssueItem[]; canBring: boolean }
  | { result: "not_found" | "github_unavailable" }
  | { result: "twin_state"; state: string };
export type TwinIssueBring =
  | { result: "ok" | "already"; privateIssue: number }
  | { result: "not_found" | "no_issue" | "issue_not_open" | "github_unavailable" | "not_private" | "visibility_unknown" | "in_progress" }
  | { result: "twin_state"; state: string };

type Deps = Pick<RunnerCloudDeps, "appUserPool" | "setupInstall" | "repoVisibility" | "repoVisibilityTimeoutMs">;
const WORKING = new Set(["ready", "paused", "conflict"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TWIN_ISSUES_SHOWN = 20;
export const TWIN_ISSUE_QUOTE_MAX_BYTES = 64 * 1024;
export const TWIN_ISSUE_RECORD_FAILED_STAGE = "twin.issue_record_failed";
export class TwinIssueRecordFailed extends Error {
  static fixedMessage = "twin.issue_record_failed";
  readonly code = "twin_issue_record_failed";
}

interface Row { state: string; pub_id: string | null; pub_owner: string | null; pub_name: string | null; priv_id: string | null; priv_owner: string | null; priv_name: string | null }
const repoOf = (id: string | null, owner: string | null, name: string | null): PullRequestRepo | null => (id === null || owner === null || name === null ? null : { id, owner, name });

async function load(client: PoolClient, accountId: string, twinId: string): Promise<Row | null> {
  const { rows } = await client.query<Row>(
    `SELECT t.state, p.id AS pub_id, p.gh_owner AS pub_owner, p.gh_name AS pub_name, v.id AS priv_id, v.gh_owner AS priv_owner, v.gh_name AS priv_name
       FROM repo_twins t LEFT JOIN repos p ON p.account_id = t.account_id AND p.id = t.public_repo_id LEFT JOIN repos v ON v.account_id = t.account_id AND v.id = t.private_repo_id
      WHERE t.account_id = $1 AND t.id = $2`,
    [accountId, twinId],
  );
  return rows[0] ?? null;
}

/**
 * Plain text only: no control characters (C0 but tab and newline, C1, DEL), no bidi or zero-width marks and no line or paragraph separators, and names and logins reduced to what cannot ping, link or format. Tab and newline survive
 * (they are inside the fence); `broughtTitle` turns them into spaces.
 */
const clean = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "");
const plainName = (name: string): string => name.replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;
/** GitHub refuses an issue body over this many characters (UTF-16 units are counted, the stricter way). */
const BODY_MAX = BROUGHT_ISSUE_BODY_MAX;
const CUT_NOTE = "\n\n(The original was cut here to fit in an issue.)";

/** The title of the copy: the public title with every control character (a tab too) made a space and the bidi and zero-width marks removed, cut by UTF-16 length to the 256 the fence allows, never inside a surrogate pair. */
export function broughtTitle(title: string): string {
  const t = clean(title.replace(/[\u0000-\u001f\u007f]/g, " ")).trim();
  let out = "";
  for (const ch of t) {
    if (out.length + ch.length > 256) break;
    out += ch;
  }
  out = out.trimEnd();
  return out === "" ? "(no title)" : out;
}

/**
 * The copy's body: the fixed header, then the original text, inert. The WHOLE body, header, `> ` prefixes, fences and the cut note, is at most 65,536 characters: the text is cut first, on a code-point boundary, to the longest piece (of at
 * most 64 KiB of UTF-8) that fits, and only then is the fence chosen (longer than any backtick run left in the piece) and closed, so the closing fence and the note are always there when anything was cut. The public issue is named
 * `number N`, never `#N`, which would link to the private repository's own issue of that number.
 */
export function broughtBody(input: { number: number; person: string; author: string; text: string }): string {
  const person = plainName(input.person) || "a team member";
  const author = LOGIN.test(input.author) ? input.author : "an unknown user";
  const header = `Brought from public issue number ${input.number} by ${person}. The text below was written by ${author} on the public repo and is untrusted.`;
  const points = Array.from(clean(input.text));
  const assemble = (n: number, cut: boolean): string => {
    const text = points.slice(0, n).join("");
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    const quoted = [fence, ...text.split("\n"), fence].map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
    return `${header}\n\n${quoted}${cut ? CUT_NOTE : ""}\n`;
  };
  let bytes = 0;
  let n = 0;
  while (n < points.length && bytes + Buffer.byteLength(points[n]!, "utf8") <= TWIN_ISSUE_QUOTE_MAX_BYTES) bytes += Buffer.byteLength(points[n++]!, "utf8");
  let cut = n < points.length;
  if (assemble(n, cut).length > BODY_MAX) {
    cut = true;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (assemble(mid, true).length <= BODY_MAX) lo = mid;
      else hi = mid - 1;
    }
    n = lo;
  }
  return assemble(n, cut);
}

/** The open issues of the twin's public repository, for any member; `canBring` is true for an owner or admin. */
export async function listTwinIssues(deps: Pick<Deps, "appUserPool" | "setupInstall">, principal: { accountId: string; userId: string }, twinId: string): Promise<TwinIssueList> {
  if (!UUID.test(twinId)) return { result: "not_found" };
  const id = twinId.toLowerCase();
  const seen = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    const twin = await load(client, principal.accountId, id);
    const brought = new Map((await client.query<{ public_issue: number; private_issue: number }>("SELECT public_issue, private_issue FROM twin_issue_imports WHERE account_id = $1 AND twin_id = $2", [principal.accountId, id])).rows.map((r) => [r.public_issue, r.private_issue]));
    return { role, twin, brought };
  });
  if (seen.twin === null) return { result: "not_found" };
  if (!WORKING.has(seen.twin.state)) return { result: "twin_state", state: seen.twin.state };
  const repo = repoOf(seen.twin.pub_id, seen.twin.pub_owner, seen.twin.pub_name);
  const port = deps.setupInstall ?? null;
  if (repo === null || port === null) return { result: "github_unavailable" };
  try {
    const issues = await port.listOpenIssues({ repo, limit: TWIN_ISSUES_SHOWN });
    return { result: "ok", issues: issues.map((i) => ({ ...i, brought: seen.brought.get(i.number) ?? null })), canBring: seen.role === "owner" || seen.role === "admin" };
  } catch (error) {
    // fx-swallow-ok: a GitHub failure says at most a status; the person is told only that GitHub could not be asked
    if (error instanceof RunPullRequestError) return { result: "github_unavailable" };
    throw error;
  }
}

/** Brings one open issue of the public repository into the private twin (owner or admin; a session with no such role throws 42501). */
export async function bringTwinIssue(deps: Deps, principal: { accountId: string; userId: string }, twinId: string, publicIssue: number): Promise<TwinIssueBring> {
  if (!UUID.test(twinId) || !Number.isSafeInteger(publicIssue) || publicIssue < 1) return { result: "not_found" };
  const id = twinId.toLowerCase();
  const seen = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") return "forbidden" as const;
    const twin = await load(client, principal.accountId, id);
    const who = (await client.query<{ n: string | null }>("SELECT COALESCE(NULLIF(name, ''), NULLIF(github_login, '')) AS n FROM users WHERE id = $1", [principal.userId])).rows[0]?.n ?? null;
    return { twin, who };
  });
  if (seen === "forbidden") throw Object.assign(new Error("twin issue: owner or admin only"), { code: "42501" });
  if (seen.twin === null) return { result: "not_found" };
  if (!WORKING.has(seen.twin.state)) return { result: "twin_state", state: seen.twin.state };
  const pub = repoOf(seen.twin.pub_id, seen.twin.pub_owner, seen.twin.pub_name);
  const priv = repoOf(seen.twin.priv_id, seen.twin.priv_owner, seen.twin.priv_name);
  const port = deps.setupInstall ?? null;
  if (pub === null || priv === null || port === null) return { result: "github_unavailable" };
  // Claim first: only the claim's winner goes to GitHub. A live claim without a number is another click still at work; a recorded number is the answer.
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, principal.accountId, principal.userId, fn);
  const claim = (await tenant((client) => client.query<{ o_result: string; o_private_issue: number | null; o_claim: string | null }>("SELECT o_result, o_private_issue, o_claim FROM twin_issue_claim($1::uuid, $2::integer)", [id, publicIssue]))).rows[0];
  if (claim?.o_result === "already" && claim.o_private_issue !== null) return { result: "already", privateIssue: claim.o_private_issue };
  if (claim?.o_result === "in_progress") return { result: "in_progress" };
  if (claim?.o_result === "not_found") return { result: "not_found" };
  if (claim?.o_result !== "claimed" || claim.o_claim === null) return { result: "twin_state", state: seen.twin.state };
  const claimId = claim.o_claim;
  // Whatever stops short of a created issue gives the claim back at once, so the click can be made again; a claim the cloud cannot give back lapses by itself after five minutes.
  const release = () => tenant((client) => client.query("SELECT twin_issue_release($1::uuid, $2::integer, $3::uuid)", [id, publicIssue, claimId])).then(() => undefined, () => undefined);
  let made: number;
  try {
    const issue = await port.readIssue({ repo: pub, number: publicIssue });
    if (issue === null || issue.pull || !issue.open) {
      await release();
      return issue === null ? { result: "no_issue" } : { result: "issue_not_open" };
    }
    // Nothing is written into the private repository unless it is still private, read live, now, for EVERY state this accepts (a paused twin too: the shared guard skips those, so this reads for itself).
    const seenPrivate = await readRepoVisibility(deps, principal.accountId, priv.id);
    if (seenPrivate !== "private") {
      if (seenPrivate === "public") await tenant((client) => client.query("SELECT o_result FROM twin_visibility_record($1::uuid, 'public', NULL)", [id])).then(() => undefined, () => undefined);
      await release();
      return { result: seenPrivate === "public" ? "not_private" : "visibility_unknown" };
    }
    made = await port.createBroughtIssue({ repo: priv, title: broughtTitle(issue.title), body: broughtBody({ number: issue.number, person: seen.who ?? "", author: issue.author, text: issue.body }) });
  } catch (error) {
    await release();
    // fx-swallow-ok: a GitHub failure says at most a status; the person is told only that GitHub could not be asked
    if (error instanceof RunPullRequestError) return { result: "github_unavailable" };
    throw error;
  }
  // GitHub has made the issue: nothing below may turn the answer into a failure. The claim is ours alone, so the record sets the number once; if the claim was retaken meanwhile (this bring took over five minutes) the record writes nothing and says so.
  try {
    const res = (await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => client.query<{ o_result: string; o_private_issue: number | null }>("SELECT o_result, o_private_issue FROM twin_issue_record($1::uuid, $2::integer, $3::integer, $4::uuid)", [id, publicIssue, made, claimId]))).rows[0];
    if (res?.o_result === "already" && res.o_private_issue !== null) return { result: "already", privateIssue: res.o_private_issue };
    if (res?.o_result !== "ok") reportError(new TwinIssueRecordFailed(), { stage: TWIN_ISSUE_RECORD_FAILED_STAGE });
  } catch {
    // fx-swallow-ok: the issue is made on GitHub; the failed record is reported under its one fixed class, with no text from the error
    reportError(new TwinIssueRecordFailed(), { stage: TWIN_ISSUE_RECORD_FAILED_STAGE });
  }
  return { result: "ok", privateIssue: made };
}
