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
 */
export type ResumeCause = "child_result" | "timeout" | "request_refused";

/** The typed context the orchestrator attaches to every resumed run. */
export interface ResumeContext {
  cause: ResumeCause;
  /** Present at least when cause is "request_refused" — why. Optional for
   *  the other two causes, which are usually self-explanatory. */
  reason?: string;
}

export const RESUME_CAUSES: readonly ResumeCause[] = ["child_result", "timeout", "request_refused"];

export function isResumeCause(value: unknown): value is ResumeCause {
  return typeof value === "string" && (RESUME_CAUSES as readonly string[]).includes(value);
}
