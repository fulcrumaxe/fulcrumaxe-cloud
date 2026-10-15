import { opsOrigin } from "./env";

export type CsrfRefusal = "origin_unconfigured" | "origin_mismatch" | "content_type" | "no_session";

export interface CsrfInput {
  method: string;
  pathname: string;
  origin: string | null;
  contentType: string | null;
  /** The request carries a valid, unexpired ops session. */
  hasSession: boolean;
}

/**
 * A console mutation (any non-GET/HEAD under /api/) needs the Origin to equal FX_OPS_ORIGIN and a JSON content type. It also
 * needs a valid ops session, except under /api/auth/*: those requests run before a session exists and are protected by a
 * signed, short-lived, single-use WebAuthn challenge instead (lib/webauthn.ts). Returns the refusal, or null to let it through.
 */
export function csrfRefusal(input: CsrfInput, env: Readonly<Record<string, string | undefined>> = process.env): CsrfRefusal | null {
  const method = input.method.toUpperCase();
  if (!input.pathname.startsWith("/api/") || method === "GET" || method === "HEAD") return null;
  const expected = opsOrigin(env);
  if (!expected) return "origin_unconfigured";
  if (input.origin !== expected) return "origin_mismatch";
  if (!(input.contentType ?? "").toLowerCase().startsWith("application/json")) return "content_type";
  if (!input.pathname.startsWith("/api/auth/") && !input.hasSession) return "no_session";
  return null;
}
