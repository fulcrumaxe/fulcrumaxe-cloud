/**
 * D#598 P1f-2b: the platform's commit identity on a public push, from two hosted settings. One reader for every runtime that publishes (the runner
 * token route now, the sandbox publish step in P1f-5), so they cannot disagree. It takes the environment as an argument and reads nothing itself.
 *
 * A missing or malformed value is reported by SETTING NAME only, never by its value: a malformed one is whatever someone pasted. The route answers
 * 503 `not_configured` on any problem, before it writes an attempt row or mints a token.
 */

export const PLANE_PUSH_IDENTITY_NAME_VAR = "FX_PLANE_PUSH_IDENTITY_NAME";
export const PLANE_PUSH_IDENTITY_EMAIL_VAR = "FX_PLANE_PUSH_IDENTITY_EMAIL";

/** The patterns the run-end route applies to the identity (`validateInput` in packages/pipeline imports these). */
export const PLANE_IDENTITY_NAME = /^[A-Za-z0-9 ._-]{1,100}$/;
export const PLANE_IDENTITY_EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,100}$/;

export interface PlanePushIdentity {
  name: string;
  email: string;
}

export type PlanePushIdentityProblem = { setting: string; problem: "missing" | "malformed" };
export type PlanePushIdentityResult = { ok: true; identity: PlanePushIdentity } | { ok: false; problems: PlanePushIdentityProblem[] };

export function readPlanePushIdentity(env: Readonly<Record<string, string | undefined>>): PlanePushIdentityResult {
  const problems: PlanePushIdentityProblem[] = [];
  const check = (setting: string, pattern: RegExp): string | null => {
    const raw = env[setting];
    if (raw === undefined || raw.trim() === "") {
      problems.push({ setting, problem: "missing" });
      return null;
    }
    // No trimming: the value is used as written, and a stray space or newline is a malformed setting, not something to repair quietly.
    if (!pattern.test(raw) || raw.trim() !== raw) {
      problems.push({ setting, problem: "malformed" });
      return null;
    }
    return raw;
  };
  const name = check(PLANE_PUSH_IDENTITY_NAME_VAR, PLANE_IDENTITY_NAME);
  const email = check(PLANE_PUSH_IDENTITY_EMAIL_VAR, PLANE_IDENTITY_EMAIL);
  if (name === null || email === null) return { ok: false, problems };
  return { ok: true, identity: { name, email } };
}
