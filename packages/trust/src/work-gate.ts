/**
 * Turns an author-trust classification into the two decisions the
 * pipeline actually needs: whether an incoming event may create work at
 * all (Spec H07 #3, #5), and — once a work item exists — whether it may
 * auto-merge (Spec H07 #4).
 */

import { classifyAuthor, type AuthorTrust, type ClassifyAuthorInput } from "./author-trust.js";
import { sanitize } from "./sanitize.js";

export interface WorkEvent extends ClassifyAuthorInput {
  /** Raw comment/issue/discussion body text for this event. */
  body: string;
}

export interface StoredWorkEvent {
  trust: AuthorTrust;
  /** False for any untrusted-author event — the event may still be
   * stored, but only as fenced data, never as a work order. */
  canCreateWork: boolean;
  /**
   * The event body exactly as the author wrote it — byte-identical to
   * `event.body`, for both a trusted and an untrusted author, never
   * normalized, never fenced (security review, fix round 2, item #5).
   * `sanitize()` NFKC-normalizes text as part of closing a real evasion
   * gap (fix round #5): "x² + ½" becomes "x2 + 1/2", circled digits
   * become plain digits, mathematical bold becomes plain ASCII. That
   * rewrite is necessary for `storedBody` (below), but it means
   * `storedBody` is NOT what the author actually typed. `rawBody` exists
   * so the pipeline can display what a human actually wrote — a comment
   * view, an audit log, a diff — without silently rewriting their text.
   *
   * PIPELINE REQUIREMENT: display `rawBody`. Never build a model prompt
   * from `rawBody` — always from `storedBody`. See
   * `packages/trust/README.md`.
   */
  rawBody: string;
  /** The body exactly as it must be fed to a prompt: untouched for a
   * trusted author, sanitized and fenced (see `sanitize`) for anyone
   * else. Never render this as "what the author wrote" — see `rawBody`
   * above. */
  storedBody: string;
}

/**
 * Spec H07 #3: false for an untrusted author, regardless of what the
 * body says. `canCreateWork` and `classifyAuthor` read the exact same
 * `ClassifyAuthorInput` fields — there is only one trust decision, not a
 * separate one that a caller could accidentally diverge from.
 */
export function canCreateWork(event: WorkEvent): boolean {
  return classifyAuthor(event) === "trusted";
}

/**
 * Classify `event` and, in the same pass, produce the body exactly as it
 * must be stored. Stateless and re-derived from the event's own author
 * fields on every call — nothing about a work item's prior approval state
 * feeds into this function, so there is no cached verdict that could go
 * stale. A later event from an untrusted author on an already-approved
 * work item is classified — and fenced — exactly like the first untrusted
 * event ever seen for that item (Spec H07 #5, the R3 mid-flight re-check:
 * re-checking "on every scan" falls out of this function having no memory
 * to re-check against, rather than needing an explicit invalidation path).
 */
export function storeWorkEvent(event: WorkEvent): StoredWorkEvent {
  const trust = classifyAuthor(event);
  return {
    trust,
    canCreateWork: trust === "trusted",
    rawBody: event.body,
    storedBody: trust === "trusted" ? event.body : sanitize(event.body),
  };
}

export type Provenance = "internal" | "external";

export interface WorkItemProvenance {
  /**
   * The work item's origin classification. Fail-closed by construction
   * (security-review fix round, Spec H07 #4): only the exact string
   * literal "internal" is treated as internal. Everything else — the
   * literal "external", `undefined`, `null`, an absent field, "EXTERNAL",
   * "External", or any other value — is treated as external. Typed
   * `unknown` rather than `Provenance` on purpose: this function is
   * exactly the boundary where a value that arrived from a database row
   * or an upstream classifier without full validation has to be handled
   * safely, not trusted to already match the shape `Provenance`
   * documents. The original version of this function compared only
   * `=== "external"` and fell through to `true` for anything else —
   * `undefined`/`null`/absent/mixed-case provenance all read as
   * "not external" and were allowed through unattended. This decides
   * whether a stranger's PR merges unattended into a customer's repo, so
   * it is the one decision in this package that must never fail open.
   */
  provenance: unknown;
}

export interface RepoAutoMergeSettings {
  /**
   * Per-repo toggle (Spec H12 #5). Default false: "PR ready, human
   * merges." Fail-closed: only the exact boolean `true` enables
   * auto-merge at all — a truthy-but-not-`true` value (the string "true",
   * or `1`) is treated the same as `false`, `undefined`, or `null`. Typed
   * `unknown` for the same reason as `provenance` above.
   */
  autoMerge: unknown;
  /**
   * Per-repo toggle (Spec H12 #5). Default true: work that traces back to
   * an external-provenance author never auto-merges unless the customer
   * explicitly switches this guard off. Fail-closed: the guard is only
   * off when this is exactly the boolean `false`. Absent, `null`,
   * `undefined`, `0`, or any other falsy-but-not-`false` value leaves the
   * guard ON — the default posture is "block", not "allow unless
   * explicitly blocked." Typed `unknown` for the same reason as
   * `provenance` above.
   */
  blockExternalAutoMerge: unknown;
}

/**
 * Spec H07 #4. False whenever `autoMerge` isn't exactly `true`. Also
 * false whenever the work item's provenance isn't exactly the literal
 * "internal" (i.e. it's treated as external) unless
 * `blockExternalAutoMerge` is exactly `false` — true for external-
 * provenance work only when the customer has switched that guard off
 * with the literal boolean `false`. Every comparison here is `===`
 * against an exact value on purpose: this is the only decision in the
 * package that gates an unattended merge into a customer's repo, and a
 * fail-open default here is worse than a false negative anywhere else in
 * this module.
 */
export function autoMergeAllowed(
  workItem: WorkItemProvenance,
  repoSettings: RepoAutoMergeSettings,
): boolean {
  if (repoSettings.autoMerge !== true) return false;
  const isInternal = workItem.provenance === "internal";
  if (!isInternal && repoSettings.blockExternalAutoMerge !== false) return false;
  return true;
}
