import { isCanonicalPath } from "./canonicalPath.js";
import { ALLOWED_METHODS } from "./decide.js";
import { parseTarget } from "./pathTarget.js";
import { isValidRefName } from "./refName.js";
import type { Decision, InstallationTarget, ParsedRefUpdates, Product, TokenScope } from "./types.js";

/**
 * The runner's git policy (cloud-verified path A). Pure.
 *
 * A runner reaches GitHub only through git smart-HTTP, and only for the one
 * branch its signed ticket names. It never needs the REST API: the cloud opens
 * the pull request when the run ends. So this table is narrower than `decide()`
 * and stands on its own; it reuses the same path, target and ref-name helpers
 * and the same method-per-endpoint rule, and does not call `decide()`.
 *
 * TRUST BOUNDARY (same as `types.ts`): `role`, `product` and `installation` come
 * from the database lookup for the run, `ticketRef` from the verified ticket,
 * and `gitRefUpdates` from the exact receive-pack body that is forwarded
 * byte-identical if this call allows.
 */

/** The roles whose commits are pushed. Any other role may read only. */
export const RUNNER_PUSHING_ROLES: ReadonlySet<string> = new Set(["executor", "docs-writer"]);

/** The ticket's `ref` claim: the one branch a run may push. */
export const RUNNER_TICKET_REF_RE = /^fx\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-g[1-9][0-9]*$/;

// No `workflows`, `pull_requests`, `issues`, `checks` or `statuses`: GitHub itself
// refuses a push that touches .github/workflows/** with a token that lacks `workflows`.
const READ_SCOPE = { metadata: "read", contents: "read" } as const;
const PUSH_SCOPE = { metadata: "read", contents: "write" } as const;
const ZERO_OID_RE = /^0+$/;
const OID_RE = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

export interface RunnerRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  role: string;
  product: Product;
  /** The installation's single repo, from the database. */
  installation: InstallationTarget;
  /** The ticket's `ref` claim, without `refs/heads/` (e.g. `fx/<run>-g<gen>`). */
  ticketRef: string;
  /** Parsed from the body of a `git-receive-pack` POST. */
  gitRefUpdates?: ParsedRefUpdates;
}

function deny(reason: string): Decision {
  return { allow: false, reason };
}

function allow(reason: string, repo: string, permissions: TokenScope["permissions"]): Decision {
  // A fresh object per decision, so a caller cannot mutate the shared table.
  return { allow: true, reason, tokenScope: { repositories: [repo], permissions: { ...permissions } } };
}

export function decideRunner(req: RunnerRequest): Decision {
  if (!ALLOWED_METHODS.has(req.method)) return deny("method_not_allowed");
  if (!isCanonicalPath(req.path)) return deny("path_not_canonical");

  const target = parseTarget(req.path, req.query);
  if (!target) return deny("path_not_recognized");

  // Every REST route is denied: labels, merges, statuses, check runs, reviews,
  // contents (including .github/workflows/**) and the rest.
  if (target.kind === "api") return deny("runner_rest_denied");

  if (req.product !== "team") return deny("runner_product_denied");
  if (target.owner !== req.installation.owner || target.repo !== req.installation.repo) {
    return deny("repo_out_of_scope");
  }

  // One method per endpoint (decide.ts rule 4a).
  const read = req.method === "GET" || req.method === "HEAD";
  if (target.endpoint === "info/refs" && !read) return deny("info_refs_method_not_allowed");
  if (target.endpoint === "git-upload-pack" && req.method !== "POST") return deny("upload_pack_method_not_allowed");
  if (target.endpoint === "git-receive-pack" && req.method !== "POST") return deny("receive_pack_method_not_allowed");

  if (target.service === "upload-pack") return allow("runner_clone_allowed", target.repo, READ_SCOPE);

  // receive-pack from here on.
  if (!RUNNER_PUSHING_ROLES.has(req.role)) return deny("receive_pack_requires_push_capable_role");
  if (read) return allow("runner_receive_pack_discovery_allowed", target.repo, PUSH_SCOPE);

  if (!RUNNER_TICKET_REF_RE.test(req.ticketRef) || !isValidRefName(`refs/heads/${req.ticketRef}`)) {
    return deny("runner_ticket_ref_invalid");
  }
  const parsed = req.gitRefUpdates;
  if (!parsed || !parsed.complete) return deny("receive_pack_unparsed_or_incomplete");
  if (parsed.updates.length !== 1) return deny("receive_pack_not_single_ref");
  const update = parsed.updates[0]!;
  if (update.ref !== `refs/heads/${req.ticketRef}`) return deny("receive_pack_ref_not_ticket_ref");
  if (!OID_RE.test(update.new)) return deny("receive_pack_bad_object_id");
  if (ZERO_OID_RE.test(update.new)) return deny("receive_pack_delete_denied");
  return allow("runner_push_allowed", target.repo, PUSH_SCOPE);
}
