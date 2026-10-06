import { isCanonicalPath } from "./canonicalPath.js";
import { isMergeOrProtectionPath } from "./mergeProtection.js";
import { parseTarget } from "./pathTarget.js";
import { isValidRefName } from "./refName.js";
import {
  ALLOWLISTED_VERDICT_LABELS,
  lookupReviewerVerdictLabels,
  lookupRolePermissions,
  REVIEWER_ROLES,
  ROLE_PUSH_PREFIX,
  SITEKIT_PERMISSIONS,
} from "./rolePermissions.js";
import type { Decision, PermissionName, ProxyRequest, TokenScope } from "./types.js";

function deny(reason: string): Decision {
  return { allow: false, reason };
}

function allow(reason: string, repo: string, permissions: TokenScope["permissions"]): Decision {
  return { allow: true, reason, tokenScope: { repositories: [repo], permissions } };
}

/**
 * The only methods this engine ever recognizes. Exact, uppercase, no
 * normalization. Exported (D#2 Correction C28 §3 item 7) so the gh-proxy
 * route's own method exports can be pinned against THIS set, rather than
 * a second, hand-copied literal that could silently drift from it.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** REST hosts a request may target, by target kind. Compared lowercased, no port. */
const ALLOWED_API_HOST = "api.github.com";
const ALLOWED_GIT_HOST = "github.com";

const LABELS_COLLECTION_RE = /^\/issues\/\d+\/labels$/;
const LABELS_SINGLE_RE = /^\/issues\/\d+\/labels\/([^/]+)$/;
const COMMENT_RE = /^\/(issues|pulls)\/\d+\/comments$/;
const REVIEW_RE = /^\/pulls\/\d+\/reviews$/;
const CONTENTS_RE = /^\/contents(\/|$)/;
/** The issue or PR resource itself — a PATCH here is gated by `patchFields`, not a blanket rule. */
const ISSUE_OR_PR_SINGLE_RE = /^\/(issues|pulls)\/(\d+)$/;
/** A PUT (replace-all) or DELETE (clear-all) on the labels collection wipes every OTHER role's labels too. */
const LABELS_COLLECTION_DESTRUCTIVE_METHODS: ReadonlySet<string> = new Set(["PUT", "DELETE"]);

/**
 * [fix round 3, item E3] Every subpath under `/pulls/{n}/reviews` —
 * submitting a pending review (`.../events`), updating a review's text
 * (`PUT .../reviews/{id}`), dismissing one (`.../dismissals`), deleting a
 * pending one, or commenting on one — is a reviewer-only act, never a
 * generic grant from `pull_requests: write` (that permission exists so
 * `executor` can open/update a PR, not review one). The original fix
 * (round 2) only enumerated `POST .../reviews` and `PUT .../dismissals`;
 * this covers the whole family with one anchored regex instead of growing
 * the enumeration one endpoint at a time.
 */
const PULLS_REVIEW_FAMILY_RE = /^\/pulls\/\d+\/reviews(\/\d+(\/(events|dismissals|comments))?)?$/;
const REVIEW_FAMILY_WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE"]);

/**
 * Team Lead decision (fix round 2, item b): `decide()` never sees a PATCH
 * body, so it only ever approves a PATCH whose caller-parsed `patchFields`
 * are a subset of the exact field list below for that role+resource pair.
 * A role/resource pair absent here (every reviewer role, `executor` on
 * issues, `project-manager` on pulls, ...) gets an empty allowlist and so
 * can never PATCH that resource at all, regardless of which fields it asks
 * for. Keyed by `${role}:${resourceType}`.
 *
 * [fix round 3, suggestion] `project-manager:issues` includes `state`,
 * which lets project-manager close a PR too — GitHub's `/issues/{n}`
 * endpoint accepts a PR's number interchangeably with an issue's, and
 * `state`/`state_reason` say nothing about which kind of number `{n}` is.
 * This is a known, deliberate overlap, not an oversight: closing a stale
 * PR through project-manager's triage authority is legitimate, and the
 * `labels`/`assignees`/`milestone`/`base`/`maintainer_can_modify` fields
 * that would matter more for a PR specifically are denied unconditionally
 * below regardless of resource type.
 */
const PATCH_FIELD_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["project-manager:issues", new Set(["title", "body", "state", "state_reason"])],
  ["executor:pulls", new Set(["title", "body"])],
]);

/**
 * Fields no role may ever set via a PATCH, even if some future allowlist
 * edit accidentally included one: `labels` (the whole reason this rule
 * exists — see item 7 of the first fix round), `assignees`/`milestone`
 * (triage state that isn't this engine's to hand out), `base` (retargeting
 * a PR's base branch is a merge-adjacent operation), and
 * `maintainer_can_modify` (a fork-write-access toggle).
 */
const ALWAYS_DENIED_PATCH_FIELDS: ReadonlySet<string> = new Set([
  "labels",
  "assignees",
  "milestone",
  "base",
  "maintainer_can_modify",
]);

/**
 * [fix round 3, item E3] Every generic (non-reviewer-gated) write this
 * engine actually supports, enumerated explicitly with its own anchored
 * regex and exact method set — never a prefix catch-all. The previous
 * shape (`resourceForSubpath`, matching `/^\/pulls(\/|$)/` and
 * `/^\/issues(\/|$)/`) granted a generic `pull_requests`/`issues` write to
 * ANY unenumerated subpath underneath, which is how `PATCH /pulls/1/lock`
 * (not even a real GitHub endpoint) and — before this fix's review-family
 * widening — `POST /pulls/{n}/reviews/{id}/events` and
 * `PUT /pulls/{n}/reviews/{id}` (submitting or rewriting a review) were
 * all silently allowed for `executor`, which merely has `pull_requests:
 * write` to open and update its own PRs. A method+subpath combination
 * absent from this table is denied as `unknown_resource`, full stop —
 * including every method on `/contents/...` (the REST contents API has no
 * legitimate write path here at all; see the universal denial above for
 * PUT/DELETE, and this table simply defines no route for anything else).
 *
 * `permissions` is a list, not a single value: [fix round 4, item 1]
 * `/issues/{n}/comments` is how GitHub routes BOTH issue comments AND PR
 * conversation comments (a PR is an issue under the hood), so a role that
 * only has `pull_requests: write` — `executor`, `browser-tester` — needs
 * this route too, not just a role with `issues: write`. ANY permission in
 * the list being `"write"` on the caller's role satisfies the route.
 *
 * [fix round 4, item 4] `requested_reviewers` is POST-only now — DELETE
 * (withdrawing a review request) was never something any role's workflow
 * actually does, and dropping it is strictly narrower than before.
 */
const ENUMERATED_GENERIC_WRITE_ROUTES: ReadonlyArray<{
  re: RegExp;
  methods: ReadonlySet<string>;
  permissions: readonly PermissionName[];
}> = [
  { re: /^\/issues$/, methods: new Set(["POST"]), permissions: ["issues"] },
  {
    re: /^\/issues\/\d+\/comments$/,
    methods: new Set(["POST"]),
    permissions: ["issues", "pull_requests"],
  },
  { re: /^\/pulls$/, methods: new Set(["POST"]), permissions: ["pull_requests"] },
  { re: /^\/pulls\/\d+\/comments$/, methods: new Set(["POST"]), permissions: ["pull_requests"] },
  {
    re: /^\/pulls\/\d+\/requested_reviewers$/,
    methods: new Set(["POST"]),
    permissions: ["pull_requests"],
  },
];

function lookupGenericWriteRoute(method: string, subpath: string): readonly PermissionName[] | null {
  for (const route of ENUMERATED_GENERIC_WRITE_ROUTES) {
    if (route.re.test(subpath) && route.methods.has(method)) {
      return route.permissions;
    }
  }
  return null;
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Normalizes a host for comparison: lowercased, and only ever one of the
 * two hosts this engine ever proxies to. Anything else — including either
 * allowed host with a port suffix — returns `null` so callers deny rather
 * than compare against a value that was never actually validated.
 */
function canonicalHost(host: string): string | null {
  const lower = host.toLowerCase();
  if (lower !== ALLOWED_API_HOST && lower !== ALLOWED_GIT_HOST) return null;
  return lower;
}

/** Every role that may push at all: the executor, plus each role in `ROLE_PUSH_PREFIX`. */
function isPushCapableRole(role: string): boolean {
  return role === "executor" || ROLE_PUSH_PREFIX.has(role);
}

/** `prefix` without its trailing slash — the bare root ref itself (e.g. "refs/heads/fx/docs"). */
function bareRootFor(prefix: string): string {
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

/**
 * True when `role` may push the ref update targeting `ref`.
 *
 * Team Lead decision (fix round 2, item a): `docs-writer`, `release-manager`
 * and `runbook-writer` each push only within their own
 * `refs/heads/fx/<name>/*` sub-prefix. `executor` pushes anywhere under
 * `refs/heads/fx/*` EXCEPT those three sub-prefixes — so none of the four
 * push-capable roles can ever touch a branch prefix that isn't its own,
 * including each other's.
 *
 * [fix round 3, item W3] Fixed a boundary bug: the OWNING role's own check
 * now also accepts the bare root ref itself (`ref === "refs/heads/fx/docs"`,
 * no trailing content), not just `ref.startsWith(ownPrefix)`. Before that
 * fix, `docs-writer` was denied its own root — only `fx/docs/*` matched,
 * never bare `fx/docs`.
 *
 * [fix round 4, item 3] `executor`'s exclusion used to be the round-3
 * fix's LOOSER plain string prefix (`ref.startsWith(bareRootFor(...))`,
 * no slash required) — deliberately more conservative than the owning
 * role's own grant, so it also denied any lookalike sibling sharing the
 * same characters, like `fx/docsX`. That turned out to over-reach: only
 * the EXACT bare root (`refs/heads/fx/docs`, pushed as a leaf ref) can
 * make every future `refs/heads/fx/docs/*` push permanently impossible in
 * git (a ref can't be both a leaf and a directory in the refs hierarchy) —
 * `fx/docsX`, `fx/release-2.0` and `fx/runbooks-old` are all real,
 * unrelated branch names that share no git-hierarchy relationship with
 * anyone's reserved prefix at all, and the loose check blocked them for
 * executor for no reason. `executor`'s exclusion is now the SAME
 * exact-segment boundary the owning role's own grant already uses
 * (`ref === root || ref.startsWith(root + "/")`) — precise on both sides,
 * with the bare-root denial for executor still intact.
 */
function canRolePush(role: string, ref: string): boolean {
  if (!isValidRefName(ref)) return false;
  if (!ref.startsWith("refs/heads/fx/")) return false;

  const ownPrefix = ROLE_PUSH_PREFIX.get(role);
  if (ownPrefix) {
    return ref === bareRootFor(ownPrefix) || ref.startsWith(ownPrefix);
  }
  if (role === "executor") {
    for (const otherPrefix of ROLE_PUSH_PREFIX.values()) {
      const root = bareRootFor(otherPrefix);
      if (ref === root || ref.startsWith(`${root}/`)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Decide whether one proxied request is allowed, and if so what token
 * scope should back it. Pure function: same input always yields the same
 * output, no I/O of any kind.
 */
export function decide(req: ProxyRequest): Decision {
  // 0. Exact method allowlist. No case-folding, no synonyms.
  if (!ALLOWED_METHODS.has(req.method)) {
    return deny("method_not_allowed");
  }

  // 1. Host allowlist, compared lowercased, with no port accepted on either
  // side — then domain fronting (Host must equal the TLS SNI host).
  const host = canonicalHost(req.host);
  const sni = canonicalHost(req.sniHost);
  if (!host || !sni) {
    return deny("host_not_allowed");
  }
  if (host !== sni) {
    return deny("host_sni_mismatch");
  }

  // 2. The path must already be canonical: no `.`/`..`/empty segments, no
  // embedded query/fragment, no backslash, no forbidden character or
  // percent-encoding, no trailing slash. Never normalized and re-judged —
  // see canonicalPath.ts. Keyword casing is enforced further down, by the
  // specific case-sensitive regex that owns each keyword's position, not
  // here (see canonicalPath.ts's docstring for why a position-blind check
  // over-denies real content).
  if (!isCanonicalPath(req.path)) {
    return deny("path_not_canonical");
  }

  const target = parseTarget(req.path, req.query);
  if (!target) {
    return deny("path_not_recognized");
  }

  // 3. The host must match the kind of traffic it's carrying: REST only on
  // api.github.com, git smart-HTTP only on github.com.
  if (target.kind === "api" && host !== ALLOWED_API_HOST) {
    return deny("host_not_allowed");
  }
  if (target.kind === "git" && host !== ALLOWED_GIT_HOST) {
    return deny("host_not_allowed");
  }

  // 4. Every request must stay inside the installation's single repo.
  if (target.owner !== req.installation.owner || target.repo !== req.installation.repo) {
    return deny("repo_out_of_scope");
  }

  // 4a. [D#2 fix round 1, must-fix 2] Every git target accepts exactly one
  // method, keyed to the literal URL ENDPOINT, not the logical service:
  // GET/HEAD on `info/refs` (ref discovery, no mutation), and POST on
  // `git-upload-pack` and on `git-receive-pack`. Nothing else, for any role
  // or product -- checked here, before either product branch, so sitekit
  // and team both inherit it instead of each re-deriving it. This closes
  // the pre-fix bug: `decide()` used to return `clone_allowed` for ANY
  // method once `target.service === "upload-pack"`, which is how PUT,
  // PATCH and DELETE on git-upload-pack (and on info/refs) reached GitHub
  // with a minted credential (the review's live-verified finding).
  if (target.kind === "git") {
    if (target.endpoint === "info/refs" && !isReadMethod(req.method)) {
      return deny("info_refs_method_not_allowed");
    }
    if (target.endpoint === "git-upload-pack" && req.method !== "POST") {
      return deny("upload_pack_method_not_allowed");
    }
    if (target.endpoint === "git-receive-pack" && req.method !== "POST") {
      return deny("receive_pack_method_not_allowed");
    }
  }

  // 5. No role may merge a PR or touch protection/collaborator/hook/key state.
  if (target.kind === "api" && isMergeOrProtectionPath(req.method, target.subpath)) {
    return deny("merge_or_protection_denied");
  }

  // 6. A PUT (replace-all) or DELETE (clear-all) on the labels collection
  // wipes every role's labels, not just the caller's own — never allowed,
  // for any role. Adding (POST) or removing one label (DELETE on the
  // single-label path) are the only label mutations this engine ever
  // approves, and only for the matching reviewer role (below).
  if (
    target.kind === "api" &&
    LABELS_COLLECTION_RE.test(target.subpath) &&
    LABELS_COLLECTION_DESTRUCTIVE_METHODS.has(req.method)
  ) {
    return deny("labels_collection_replace_or_clear_denied");
  }

  // 7. The REST contents API is never a write path, for any role. The only
  // way to change repo contents is a git push through git-receive-pack,
  // each push-capable role confined to its own refs/heads/fx/* sub-prefix
  // (handled below). See the note on ROLE_PERMISSIONS in rolePermissions.ts
  // for why. (No route in ENUMERATED_GENERIC_WRITE_ROUTES exists for
  // /contents/... either, so any OTHER method against it — a POST, say —
  // falls through to the default unknown_resource deny below anyway.)
  if (
    target.kind === "api" &&
    CONTENTS_RE.test(target.subpath) &&
    (req.method === "PUT" || req.method === "DELETE")
  ) {
    return deny("contents_write_via_rest_denied");
  }

  // 8. The role itself must be one this engine actually knows about. Uses
  // Object.hasOwn under the hood — never a raw `ROLE_PERMISSIONS[role]` —
  // so a role of "toString" or "__proto__" can't resolve through the
  // prototype chain into something truthy. Checked before EITHER product
  // branch: sitekit must deny an unknown role exactly like team does.
  const rolePerms = lookupRolePermissions(req.role);
  if (!rolePerms) {
    return deny("unknown_role");
  }

  // 9. Sitekit is read-only end to end, for every (known) role. Method is
  // already gated at 4a: GET/HEAD only ever reaches here via `info/refs`
  // discovery, POST only ever reaches here via the literal
  // `git-upload-pack` endpoint (git-receive-pack's OWN method gate at 4a
  // fires first regardless, but sitekit denies it below anyway by service).
  if (req.product === "sitekit") {
    if (target.kind === "git") {
      if (target.service !== "upload-pack") return deny("sitekit_write_denied");
      return allow("sitekit_clone_allowed", target.repo, SITEKIT_PERMISSIONS);
    }
    if (isReadMethod(req.method)) {
      return allow("sitekit_read_allowed", target.repo, SITEKIT_PERMISSIONS);
    }
    return deny("sitekit_write_denied");
  }

  // From here on: product === "team".

  if (target.kind === "git") {
    if (target.service === "upload-pack") {
      // Method already gated at 4a: only a POST to the literal
      // git-upload-pack endpoint reaches here.
      return allow("clone_allowed", target.repo, rolePerms);
    }

    // receive-pack (push): only a push-capable role, and only onto that
    // role's own refs/heads/fx/* sub-prefix.
    if (!isPushCapableRole(req.role)) {
      return deny("receive_pack_requires_push_capable_role");
    }

    // Ref advertisement (`GET/HEAD .../info/refs?service=git-receive-pack`)
    // carries no ref-update body yet — it's how a real `git push` discovers
    // what to push against. Allow it for every push-capable role so a push
    // can start at all; the actual mutation is still gated below on the POST.
    // Method already gated at 4a: only GET/HEAD via info/refs, or POST via
    // the literal git-receive-pack endpoint, ever reach this point.
    if (isReadMethod(req.method)) {
      return allow("receive_pack_discovery_allowed", target.repo, rolePerms);
    }

    const parsed = req.gitRefUpdates;
    if (!parsed || !parsed.complete) {
      return deny("receive_pack_unparsed_or_incomplete");
    }
    if (parsed.updates.length === 0) {
      return deny("receive_pack_no_ref_updates");
    }
    if (!parsed.updates.every((u) => canRolePush(req.role, u.ref))) {
      return deny("receive_pack_ref_outside_allowed_prefix");
    }
    return allow("push_to_fx_branch_allowed", target.repo, rolePerms);
  }

  // target.kind === "api"

  // 10. A PATCH on the issue/PR resource itself is gated on the caller-
  // parsed `patchFields`, never guessed at from an unseen body. Applies to
  // every role uniformly, reviewer or not — no role gets to PATCH `labels`
  // (or `assignees`/`milestone`/`base`/`maintainer_can_modify`) this way.
  const issueOrPrMatch = ISSUE_OR_PR_SINGLE_RE.exec(target.subpath);
  if (issueOrPrMatch && req.method === "PATCH") {
    const resourceType = issueOrPrMatch[1]; // "issues" | "pulls"
    const fields = req.patchFields;
    if (!fields || fields.length === 0) {
      return deny("issue_or_pr_patch_denied");
    }
    if (fields.some((f) => ALWAYS_DENIED_PATCH_FIELDS.has(f))) {
      return deny("issue_or_pr_patch_field_denied");
    }
    const allowlist = PATCH_FIELD_ALLOWLIST.get(`${req.role}:${resourceType}`);
    if (!allowlist || !fields.every((f) => allowlist.has(f))) {
      return deny("issue_or_pr_patch_field_denied");
    }
    return allow("issue_or_pr_patch_allowed", target.repo, rolePerms);
  }

  if (REVIEWER_ROLES.has(req.role)) {
    const ownLabels = lookupReviewerVerdictLabels(req.role);

    const singleLabelMatch = LABELS_SINGLE_RE.exec(target.subpath);
    if (singleLabelMatch && req.method === "DELETE") {
      // `isCanonicalPath` (step 2) already rejects every percent-encoded
      // byte >= 0x80, so nothing reaching this line can decode into an
      // invalid multi-byte UTF-8 sequence in practice — this catch is
      // defense-in-depth for `decodeURIComponent` specifically, not a path
      // any current input can take. Kept rather than removed: a single-
      // label DELETE is exactly the kind of call site that should never
      // trust a decode to succeed just because an earlier, more general
      // layer currently happens to make it so.
      let labelName: string;
      try {
        labelName = decodeURIComponent(singleLabelMatch[1]!);
      } catch {
        return deny("malformed_label_encoding");
      }
      if (!ownLabels.has(labelName)) {
        return deny("label_not_allowlisted");
      }
      return allow("reviewer_label_remove_allowed", target.repo, rolePerms);
    }

    // Only POST (add) reaches here for the collection path — PUT/DELETE on
    // the collection were already denied for every role at step 6.
    if (LABELS_COLLECTION_RE.test(target.subpath) && req.method === "POST") {
      const names = req.labelNames;
      if (!names || names.length === 0 || !names.every((n) => ownLabels.has(n))) {
        return deny("label_not_allowlisted");
      }
      return allow("reviewer_label_write_allowed", target.repo, rolePerms);
    }

    if ((COMMENT_RE.test(target.subpath) || REVIEW_RE.test(target.subpath)) && req.method === "POST") {
      return allow("reviewer_comment_allowed", target.repo, rolePerms);
    }

    if (isReadMethod(req.method)) {
      return allow("reviewer_read_allowed", target.repo, rolePerms);
    }

    return deny("reviewer_write_denied");
  }

  // Every other role: reads are fine within repo scope; writes need an
  // explicitly enumerated route AND the matching permission at "write" in
  // the role's minimum table. The whole /pulls/{n}/reviews family (submit,
  // update, dismiss, delete, comment) is a reviewer-only act, even though
  // "pull_requests: write" (needed to open/update a PR) would otherwise
  // generically cover these same paths — non-reviewers don't review.
  if (isReadMethod(req.method)) {
    return allow("read_allowed", target.repo, rolePerms);
  }

  // [fix round 4, item 2] A non-reviewer role holding `issues: write` may
  // add or remove an ORDINARY triage label (e.g. "bug") — labels aren't
  // exclusively a reviewer concern, and the old check denied by PATH
  // (any write to a labels path at all) rather than by the label's NAME,
  // so project-manager couldn't add a plain triage label despite having
  // exactly the permission that should cover it. Verdict labels
  // (`ALLOWLISTED_VERDICT_LABELS`) stay reviewer-only regardless of this
  // permission — each one only its own owning role can touch (see the
  // REVIEWER_ROLES branch above) — checked BEFORE the permission itself,
  // so the reason a verdict-label attempt fails is always "that label is
  // reviewer-only", never "you lack a permission you might otherwise have".
  if (LABELS_COLLECTION_RE.test(target.subpath) && req.method === "POST") {
    const names = req.labelNames;
    if (!names || names.length === 0) {
      return deny("triage_label_names_required");
    }
    if (names.some((n) => ALLOWLISTED_VERDICT_LABELS.has(n))) {
      return deny("verdict_label_requires_reviewer_role");
    }
    if (rolePerms.issues !== "write") {
      return deny("role_lacks_write_permission");
    }
    return allow("triage_label_write_allowed", target.repo, rolePerms);
  }

  if (LABELS_SINGLE_RE.test(target.subpath) && req.method === "DELETE") {
    const singleLabelMatch = LABELS_SINGLE_RE.exec(target.subpath);
    // singleLabelMatch is non-null: the .test() above already matched.
    let labelName: string;
    try {
      labelName = decodeURIComponent(singleLabelMatch![1]!);
    } catch {
      return deny("malformed_label_encoding");
    }
    if (ALLOWLISTED_VERDICT_LABELS.has(labelName)) {
      return deny("verdict_label_requires_reviewer_role");
    }
    if (rolePerms.issues !== "write") {
      return deny("role_lacks_write_permission");
    }
    return allow("triage_label_remove_allowed", target.repo, rolePerms);
  }

  // Any other method against a labels path (e.g. PUT on a single label,
  // which isn't a real GitHub endpoint) falls through to the enumerated
  // route lookup below and denies as unknown_resource — PUT/DELETE on the
  // whole collection were already denied for every role at step 6.

  if (PULLS_REVIEW_FAMILY_RE.test(target.subpath) && REVIEW_FAMILY_WRITE_METHODS.has(req.method)) {
    return deny("review_requires_reviewer_role");
  }

  const permissions = lookupGenericWriteRoute(req.method, target.subpath);
  if (!permissions) {
    return deny("unknown_resource");
  }
  if (!permissions.some((p) => rolePerms[p] === "write")) {
    return deny("role_lacks_write_permission");
  }
  return allow("write_allowed", target.repo, rolePerms);
}
