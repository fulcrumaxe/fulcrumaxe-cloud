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
