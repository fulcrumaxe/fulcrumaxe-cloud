/**
 * The `next_role_request` field of an AGENT_OUTPUT envelope: the mechanism
 * that replaced `scripts/spawn-agent.sh` and `SendMessage`. A role never
 * spawns another role directly — it names who it wants started next, and
 * the orchestrator (a Workflow step, H09) reads this field after the run
 * ends and starts those roles itself.
 *
 * Canonical shape: `roles` is always a string array, even for the common
 * single-role case — a fan-out (the consensus panel, H15) can only be
 * expressed as an array, so there is one shape, not two. A role with
 * nothing to request next emits `next_role_request: null`.
 */
export interface NextRoleRequest {
  /** One or more role names for the orchestrator to start next. Never empty. */
  roles: string[];
  /** One line: why these roles, for whoever reads the envelope. */
  reason: string;
  /** Free-text context handed to each started role's run. */
  context: string;
}

/** The value of the `next_role_request` field itself — a request, or none. */
export type NextRoleRequestField = NextRoleRequest | null;

/**
 * True if `value` structurally matches `NextRoleRequestField`. Used by the
 * card-examples test (test/next-role-request.test.ts) to check every
 * embedded JSON example against this contract, not just that the field
 * name appears somewhere in the prose.
 */
export function isNextRoleRequestField(value: unknown): value is NextRoleRequestField {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.roles) &&
    v.roles.length > 0 &&
    v.roles.every((r) => typeof r === "string" && r.length > 0) &&
    typeof v.reason === "string" &&
    v.reason.length > 0 &&
    typeof v.context === "string" &&
    v.context.length > 0
  );
}

/**
 * Why the orchestrator resumed this run. Named the same way H09 names a
 * denied spend reservation's status (`refused_spend`, not a bare boolean or
 * free-text reason) — a resumed role branches on `cause`, not on prose.
 *
 * - `"child_result"`  — a role you requested (via `next_role_request`) has
 *   posted its result (a Discussion comment, a review verdict, etc.).
 * - `"timeout"`        — the configured wait elapsed with no result, or
 *   fewer results than expected.
 * - `"request_refused"` — the orchestrator declined to start a role you
 *   requested (e.g. a per-work-item round cap). `reason` explains why.
 * - `"decision_resolved"` — a `decision_request` you made was answered (by a person, or by policy
 *   that let the work go ahead). How the chosen option reaches the role is the resume task's to add.
 * - `"decision_denied"` — a `decision_request` you made was refused. Do not take the action.
 */
export type ResumeCause = "child_result" | "timeout" | "request_refused" | "decision_resolved" | "decision_denied";

/** The typed context the orchestrator attaches to every resumed run. */
export interface ResumeContext {
  cause: ResumeCause;
  /** Present at least when cause is "request_refused" — why. Optional for
   *  the other two causes, which are usually self-explanatory. */
  reason?: string;
  /**
   * Present only with cause "decision_resolved" (D#7 DP4b-1): the id of the option that was chosen, so the resumed role is told
   * which way to go. An ask option id (`^[a-z][a-z0-9_]{0,31}$`); "deny" is a different cause, "decision_denied", and carries none.
   */
  option?: string;
}

export const RESUME_CAUSES: readonly ResumeCause[] = ["child_result", "timeout", "request_refused", "decision_resolved", "decision_denied"];

export function isResumeCause(value: unknown): value is ResumeCause {
  return typeof value === "string" && (RESUME_CAUSES as readonly string[]).includes(value);
}

/** The shape of an ask option id (migration 0666's definer). */
const RESUME_OPTION_ID = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Whether `value` is a well-formed ResumeContext: a known cause, an optional string reason, and an `option` only with
 * "decision_resolved" and in the option-id shape. Any other key is refused, so a field added without a reviewed change here does not pass.
 */
export function isResumeContext(value: unknown): value is ResumeContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (key !== "cause" && key !== "reason" && key !== "option") return false;
  if (!isResumeCause(v.cause)) return false;
  if (v.reason !== undefined && typeof v.reason !== "string") return false;
  if (v.option !== undefined) {
    if (v.cause !== "decision_resolved") return false;
    if (typeof v.option !== "string" || !RESUME_OPTION_ID.test(v.option) || v.option === "deny") return false;
  }
  return true;
}
