import { isCanonicalPath } from "./canonicalPath.js";
import { parseTarget } from "./pathTarget.js";
import type { ParsedRefUpdates } from "./types.js";

/**
 * D#598 P1f-4b: the rule set for a `plane_publish` run, applied INSTEAD of `decide()`.
 *
 * `decide()` requires every request to stay inside the run's own repository, and a publish run has to read the private repository and write the
 * paired public one, so this rule set owns both repositories. Its inputs are the run's private repository (from the run row) and the publish
 * target (from `resolve_plane_publish_target`): both are our own rows, and nothing the sandbox sends can choose either. The sandbox sends only
 * the request being judged.
 *
 * Allowed, and nothing else:
 *   private repository   ref discovery (GET info/refs?service=git-upload-pack) and POST git-upload-pack. Read only.
 *   public repository    ref discovery for either service (GET), POST git-upload-pack, POST git-receive-pack that creates exactly the recorded
 *                        branch (one update, old id all zeros), GET of that branch's ref, and POST /pulls from that branch onto main.
 *
 * Repositories are compared exactly, case and all: a lookalike (another case, an added suffix, another owner) is a different repository.
 * Every reason this returns is one of the fixed strings in `PLANE_PUBLISH_DENY_REASONS`; none carries request text.
 */

export const PLANE_PUBLISH_ROLE = "plane_publish";
/** The only base a publish run may open a pull request onto. */
export const PLANE_PUBLISH_BASE = "main";

export const PLANE_PUBLISH_DENY_REASONS = [
  "publish_path_not_canonical",
  "publish_path_not_recognized",
  "publish_repo_out_of_scope",
  "publish_method_not_allowed",
  "publish_request_not_allowed",
  "publish_receive_pack_unparsed",
  "publish_ref_not_allowed",
  "publish_pull_request_not_allowed",
] as const;
export type PlanePublishDenyReason = (typeof PLANE_PUBLISH_DENY_REASONS)[number];

export interface PlanePublishRequest {
  method: string;
  /** The path after `/api/gh-proxy`, exactly as received. */
  path: string;
  /** The validated query map (one value per key). */
  query: Record<string, string>;
  /** The run's own (private) repository, from the run row. */
  privateRepo: { owner: string; repo: string };
  /** The paired public repository (`owner/name`) and the one branch it may publish, from our rows. */
  publishTarget: { codeRepo: string; branch: string };
  /** For a POST to git-receive-pack: the ref updates parsed from THIS request's bytes. */
  gitRefUpdates?: ParsedRefUpdates;
  /** For a POST to `/pulls`: the JSON object parsed from THIS request's bytes, or null when it did not parse or repeated a key. */
  pullRequestBody?: Record<string, unknown> | null;
}

export type PlanePublishDecision =
  | { allow: true; /** Which repository the request goes to, and so which token it needs. */ side: "private" | "public"; reason: string }
  | { allow: false; reason: PlanePublishDenyReason };

const deny = (reason: PlanePublishDenyReason): PlanePublishDecision => ({ allow: false, reason });
const allow = (side: "private" | "public", reason: string): PlanePublishDecision => ({ allow: true, side, reason });

const ZERO_ID = /^(0{40}|0{64})$/;
const OBJECT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;
/** The fields `openPullRequest` sends. Anything else (an `issue` to convert, a `head_repo`) is refused. */
const PULL_REQUEST_FIELDS: ReadonlySet<string> = new Set(["title", "body", "head", "base", "maintainer_can_modify", "draft"]);

export function decidePlanePublish(req: PlanePublishRequest): PlanePublishDecision {
  if (!isCanonicalPath(req.path)) return deny("publish_path_not_canonical");
  const target = parseTarget(req.path, req.query);
  if (!target) return deny("publish_path_not_recognized");

  const parts = req.publishTarget.codeRepo.split("/");
  const [pubOwner, pubName] = parts;
  if (parts.length !== 2 || !pubOwner || !pubName) return deny("publish_repo_out_of_scope");
  const isPrivate = target.owner === req.privateRepo.owner && target.repo === req.privateRepo.repo;
  const isPublic = target.owner === pubOwner && target.repo === pubName;
  // Neither is a repository outside the run's two. Both would mean the pairing names the run's own repository, which is no pairing at all.
  if (isPrivate === isPublic) return deny("publish_repo_out_of_scope");
  const side = isPrivate ? "private" : "public";
  const queryKeys = Object.keys(req.query);

  if (target.kind === "git") {
    if (target.endpoint === "info/refs") {
      if (req.method !== "GET") return deny("publish_method_not_allowed");
      // Discovery names the same service as the POST it precedes. The private repository is read only.
      if (isPrivate && target.service !== "upload-pack") return deny("publish_request_not_allowed");
      return allow(side, `${side}_discovery_allowed`);
    }
    if (req.method !== "POST") return deny("publish_method_not_allowed");
    if (queryKeys.length > 0) return deny("publish_request_not_allowed");
    if (target.endpoint === "git-upload-pack") return allow(side, `${side}_upload_pack_allowed`);

    // git-receive-pack: only the public repository, and only a create of the recorded branch.
    if (isPrivate) return deny("publish_request_not_allowed");
    const parsed = req.gitRefUpdates;
    if (!parsed || !parsed.complete) return deny("publish_receive_pack_unparsed");
    const only = parsed.updates.length === 1 ? parsed.updates[0]! : null;
    if (!only || only.ref !== `refs/heads/${req.publishTarget.branch}` || !ZERO_ID.test(only.old) || !OBJECT_ID.test(only.new) || ZERO_ID.test(only.new)) {
      return deny("publish_ref_not_allowed");
    }
    return allow("public", "public_branch_create_allowed");
  }

  // A REST request: only the public repository, with no query string.
  if (isPrivate || queryKeys.length > 0) return deny("publish_request_not_allowed");
  if (req.method === "GET" && target.subpath === `/git/ref/heads/${req.publishTarget.branch}`) return allow("public", "public_branch_read_allowed");
  if (req.method === "POST" && target.subpath === "/pulls") {
    const body = req.pullRequestBody;
    if (!body || !Object.keys(body).every((k) => PULL_REQUEST_FIELDS.has(k))) return deny("publish_pull_request_not_allowed");
    if (body["head"] !== req.publishTarget.branch || body["base"] !== PLANE_PUBLISH_BASE) return deny("publish_pull_request_not_allowed");
    return allow("public", "public_pull_request_allowed");
  }
  return deny("publish_request_not_allowed");
}
