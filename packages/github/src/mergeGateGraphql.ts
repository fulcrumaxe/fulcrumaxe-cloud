import { GH_OWNER_LOGIN_RE } from "./eventMapper.js";

/**
 * D#694 B5a, B6-1 and B6-6: the six GraphQL documents the hosted `merge_gate` client may send, and the shape check for each one's variables.
 *
 * Threat model: a compromised or buggy caller of the hosted merge client tries to send an arbitrary GraphQL document with the
 * installation's write token. So the client (installationHttp.ts) lets `POST /graphql` through only when the `query` is `===` one of
 * these literal strings (no trimming, no parsing) and the variables pass that document's check below, with no extra keys.
 * Changing a document is a visible edit: the snapshot test pins all six.
 */
export const MERGE_QUEUE_READ_DOCUMENT = "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }";
export const ENQUEUE_PULL_REQUEST_DOCUMENT =
  "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { id position } } }";
export const ENABLE_AUTO_MERGE_DOCUMENT =
  "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $mergeMethod: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: $mergeMethod }) { pullRequest { id } } }";
/** D#694 B6-1: take one pull request out of the merge queue (`DequeuePullRequestInput.id` is the pull request's node id). Nothing calls it yet. */
export const DEQUEUE_PULL_REQUEST_DOCUMENT = "mutation($pullRequestId: ID!) { dequeuePullRequest(input: { id: $pullRequestId }) { mergeQueueEntry { id } } }";
/** D#694 B6-1: one pull request's state and its queue entry (null when it is not queued), read by number inside the pinned repository. */
export const MERGE_QUEUE_ENTRY_DOCUMENT =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state merged headRefOid mergeQueueEntry { id state position } } } }";

/**
 * D#694 B6-6: the newest removal of one pull request from the merge queue, read by number inside the pinned repository. `reason` is GitHub's own code, `actor.__typename` says whether a
 * person (`User`) or an app (`Bot`) did it, and `beforeCommit.oid` is the head that was queued.
 */
export const MERGE_QUEUE_REMOVAL_DOCUMENT =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason actor { __typename } beforeCommit { oid } } } } } } }";

/** The largest request body the allowance accepts, measured on the JSON the client would send. */
export const MERGE_GATE_GRAPHQL_MAX_BYTES = 4096;

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NODE_ID_RE = /^[A-Za-z0-9_=-]{1,100}$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp): boolean => typeof v === "string" && re.test(v);
/** Exactly these keys: the count matches and each named key is an own property (no comma-joined name can fake it). */
const keysAre = (v: Record<string, unknown>, keys: string): boolean => {
  const want = keys.split(",");
  return Object.keys(v).length === want.length && want.every((k) => Object.hasOwn(v, k));
};

const CHECKS: ReadonlyMap<string, (v: Record<string, unknown>) => boolean> = new Map([
  [MERGE_QUEUE_READ_DOCUMENT, (v) => keysAre(v, "branch,name,owner") && str(v["owner"], GH_OWNER_LOGIN_RE) && str(v["name"], NAME_RE) && typeof v["branch"] === "string" && v["branch"].length >= 1 && v["branch"].length <= 255 && !CONTROL_RE.test(v["branch"])],
  [ENQUEUE_PULL_REQUEST_DOCUMENT, (v) => keysAre(v, "expectedHeadOid,pullRequestId") && str(v["pullRequestId"], NODE_ID_RE) && str(v["expectedHeadOid"], OID_RE)],
  [DEQUEUE_PULL_REQUEST_DOCUMENT, (v) => keysAre(v, "pullRequestId") && str(v["pullRequestId"], NODE_ID_RE)],
  [MERGE_QUEUE_ENTRY_DOCUMENT, (v) => keysAre(v, "name,number,owner") && str(v["owner"], GH_OWNER_LOGIN_RE) && str(v["name"], NAME_RE) && typeof v["number"] === "number" && Number.isSafeInteger(v["number"]) && v["number"] >= 1],
  [MERGE_QUEUE_REMOVAL_DOCUMENT, (v) => keysAre(v, "name,number,owner") && str(v["owner"], GH_OWNER_LOGIN_RE) && str(v["name"], NAME_RE) && typeof v["number"] === "number" && Number.isSafeInteger(v["number"]) && v["number"] >= 1],
  [ENABLE_AUTO_MERGE_DOCUMENT, (v) => keysAre(v, "expectedHeadOid,mergeMethod,pullRequestId") && str(v["pullRequestId"], NODE_ID_RE) && str(v["expectedHeadOid"], OID_RE) && v["mergeMethod"] === "SQUASH"],
]);

/**
 * Returns the body to send, or undefined to refuse. The body is serialized once and the CHECKED value is that text parsed back, so what is
 * validated is what goes on the wire (a `toJSON` cannot make the two differ). Accepted only when it is exactly `{ query, variables }`,
 * `query` is `===` a pinned document, the variables pass that document's check, and the serialized body is at most 4 KiB.
 */
export function pinnedMergeGateBody(body: unknown, repo: { owner: string; name: string }, maxBytes: number = MERGE_GATE_GRAPHQL_MAX_BYTES): Record<string, unknown> | undefined {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    // fx-swallow-ok: a body that cannot be serialized is refused, nothing is sent
    return undefined;
  }
  if (text === undefined || Buffer.byteLength(text, "utf8") > maxBytes) return undefined;
  const copy: unknown = JSON.parse(text);
  if (!isRecord(copy) || !keysAre(copy, "query,variables")) return undefined;
  const query = copy["query"];
  const variables = copy["variables"];
  if (typeof query !== "string" || !isRecord(variables)) return undefined;
  const check = CHECKS.get(query);
  // The queue reads name the repository: it must be the one this client is pinned to.
  if ((query === MERGE_QUEUE_READ_DOCUMENT || query === MERGE_QUEUE_ENTRY_DOCUMENT || query === MERGE_QUEUE_REMOVAL_DOCUMENT) && (variables["owner"] !== repo.owner || variables["name"] !== repo.name)) return undefined;
  return check !== undefined && check(variables) ? copy : undefined;
}
