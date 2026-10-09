import { runCapture, type SpawnFn } from "./capture.js";

export type AuthMode = "subscription" | "api_key";

const ACCEPTED: Readonly<Record<AuthMode, ReadonlySet<string>>> = {
  subscription: new Set(["claude.ai", "oauth_token"]),
  api_key: new Set(["api_key"]),
};

export interface AuthResult {
  present: boolean;
  /** The method label the binary reported, when it is a short plain word. Nothing else of the output is kept. */
  authMethod?: string;
}

/**
 * Asks the pinned binary whether a login of the right kind exists (`auth status`: no model request). True only for the
 * accepted method of this mode, on exit 0 with parseable output inside the time limit; every other case is false, and
 * the caller refuses the job. Only `authMethod` is read: an email, an organisation or any other field is dropped here.
 */
export async function authPresent(mode: AuthMode, opts: { binaryPath: string; env: Record<string, string>; spawn: SpawnFn; timeoutMs?: number }): Promise<AuthResult> {
  const out = await runCapture(opts.spawn, opts.binaryPath, ["auth", "status"], opts.env, opts.timeoutMs ?? 10_000);
  if (out.timedOut || out.code !== 0) return { present: false };
  let method: unknown;
  try {
    method = (JSON.parse(out.stdout) as { authMethod?: unknown } | null)?.authMethod;
  } catch {
    // fx-swallow-ok: output that is not JSON is, by design, a failed check
    return { present: false };
  }
  if (typeof method !== "string" || !/^[a-z_.]{1,32}$/.test(method)) return { present: false };
  return { present: ACCEPTED[mode].has(method), authMethod: method };
}

/** What `fx-runner doctor` shows: a login of the right kind (`yes`), none or one of another kind (`no`), or the question was not answered (`unknown`). */
export interface AuthState {
  state: "yes" | "no" | "unknown";
  authMethod?: string;
}

/**
 * The same `auth status` question as `authPresent`, but "could not tell" and "no" are kept distinct. A timeout, a failure to start,
 * output that is not JSON, a method label that is not a plain word or an exit code other than 0 and 1 is `unknown`. Otherwise
 * it is `yes` (the accepted method of this mode, on exit 0) or `no`. Only the method label is read, as there.
 */
export async function authState(mode: AuthMode, opts: { binaryPath: string; env: Record<string, string>; spawn: SpawnFn; timeoutMs?: number }): Promise<AuthState> {
  const out = await runCapture(opts.spawn, opts.binaryPath, ["auth", "status"], opts.env, opts.timeoutMs ?? 10_000);
  if (out.timedOut || (out.code !== 0 && out.code !== 1)) return { state: "unknown" };
  let method: unknown;
  try {
    method = (JSON.parse(out.stdout) as { authMethod?: unknown } | null)?.authMethod;
  } catch {
    // fx-swallow-ok: output that is not JSON means the question was not answered, which is `unknown`
    return { state: "unknown" };
  }
  if (typeof method !== "string" || !/^[a-z_.]{1,32}$/.test(method)) return { state: "unknown" };
  return { state: out.code === 0 && ACCEPTED[mode].has(method) ? "yes" : "no", authMethod: method };
}
