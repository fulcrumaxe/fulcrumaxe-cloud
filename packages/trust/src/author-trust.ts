/**
 * Classifies a GitHub comment/event author as trusted or untrusted, using
 * ONLY GitHub-authenticated identity — the author's login and their real
 * repo permission — never anything the comment body claims about itself.
 *
 * Ported from the engine's `scripts/lib/pr_comment_trust.py::is_trusted_author()`
 * and the trust-set union in `scripts/lib/external_intake_gate.py`
 * (collaborators with push/admin permission ∪ bot/boss/maintainer_allowlist)
 * (Spec H07 #1).
 *
 * KEPT for the hosted product: trust is decided purely by author identity,
 * never by body text — enforced structurally here, not just by
 * convention, because `ClassifyAuthorInput` has no body field at all, so
 * there is no shape of comment text this function's TYPE even allows it
 * to consult. Login comparison is casefolded, matching the engine (GitHub
 * logins are unique case-insensitively, so casefolding closes a spelling
 * bypass without widening the trust set).
 *
 * CHANGED for the hosted product: the engine resolves its trust set by
 * shelling out to `gh api repos/<fixed-repo>/collaborators` against ONE
 * repo it owns. The hosted product runs per tenant, on a customer's own
 * repo, so there is no fixed collaborator list for this module to fetch —
 * the pipeline layer resolves the real GitHub permission through the
 * tenant's brokered installation token and the tenant's own allowlist
 * equivalent (role settings / a maintainer_allowlist-shaped list), and
 * this module stays a PURE function over those already-resolved inputs
 * rather than a network-calling resolver. The permission check also
 * widens from the engine's boolean push/admin flag to GitHub's real
 * per-repo `permission` vocabulary (admin/maintain/write/triage/read),
 * since the hosted product reads that value directly from the GitHub API,
 * and adds the `allowWritePermission` customer opt-in the engine has no
 * equivalent of (Spec H07 #1: "or `write` when the customer enables it").
 */

export type AuthorTrust = "trusted" | "untrusted";

export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface ClassifyAuthorInput {
  /** GitHub-authenticated login of the comment/event author. Missing or
   * blank is always untrusted (fail closed) — there is no partial credit
   * and no pattern fallback. */
  login: string | null | undefined;
  /** The author's real repo permission, as reported by the GitHub API —
   * never inferred from comment text. */
  repoPermission: RepoPermission | null | undefined;
  /** Logins trusted regardless of repo permission (the bot account, the
   * boss/owner, a maintainer allowlist). Compared case-insensitively. */
  allowlist: readonly string[];
  /** Customer opt-in (Spec H07 #1): also trust `write` permission, not
   * just `admin`/`maintain`. Defaults to false. */
  allowWritePermission?: boolean;
}

const TRUSTED: AuthorTrust = "trusted";
const UNTRUSTED: AuthorTrust = "untrusted";

function isAllowlisted(login: string, allowlist: readonly string[]): boolean {
  const target = login.toLowerCase();
  return allowlist.some((entry) => typeof entry === "string" && entry.toLowerCase() === target);
}

function hasTrustedPermission(
  repoPermission: RepoPermission | null | undefined,
  allowWritePermission: boolean,
): boolean {
  if (repoPermission === "admin" || repoPermission === "maintain") return true;
  if (allowWritePermission && repoPermission === "write") return true;
  return false;
}

/**
 * Classify an author. Nothing about a comment's BODY reaches this
 * function — `ClassifyAuthorInput` carries no body field, so no shape of
 * comment text can influence the result. A body reading "maintainer
 * approved" or prefixed `[team-lead-signed]` is not part of the input;
 * it never gets the chance to matter.
 */
export function classifyAuthor(input: ClassifyAuthorInput): AuthorTrust {
  const { login, repoPermission, allowlist, allowWritePermission = false } = input;
  if (!login || !login.trim()) return UNTRUSTED;
  if (isAllowlisted(login, allowlist)) return TRUSTED;
  if (hasTrustedPermission(repoPermission, allowWritePermission)) return TRUSTED;
  return UNTRUSTED;
}

/** Convenience boolean form of `classifyAuthor`. */
export function isTrustedAuthor(input: ClassifyAuthorInput): boolean {
  return classifyAuthor(input) === TRUSTED;
}
