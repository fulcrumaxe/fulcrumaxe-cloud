import { isAllowedUrl, type BasePin } from "./pin.js";
import { SIGNED_IN_AS } from "./ground.js";

/**
 * D#749 V2c-2b: who the saved session is signed in as, asked of the app itself and never of the model. The route is the app's own session route (`GET /api/cloud/auth/me`, the shell's
 * identity call; apps/web/lib/shell/session-routes.ts answers it with the signed-in user's GitHub login in `username`). It is one read-only GET on the base origin through the browser
 * context's request API, so it carries the saved session. The answer is used only if it is a 200 on the base origin itself (no redirect was followed), small, and holds a plain login string;
 * anything else is "no answer", and the cloud then fails the row closed.
 */
export const IDENTITY_PATH = "/api/cloud/auth/me";
export const MAX_IDENTITY_BYTES = 4096;

/** The little of a response this code reads; Playwright's `APIResponse` fits it. */
export interface IdentityResponse {
  status(): number;
  url(): string;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

export async function signedInAs(get: (url: string) => Promise<IdentityResponse>, base: BasePin): Promise<string | undefined> {
  try {
    const target = new URL(IDENTITY_PATH, base.href).href;
    const res = await get(target);
    // No redirect: a 3xx is not a 200, and a response whose final address is not exactly the one asked for was redirected.
    if (res.status() !== 200 || res.url() !== target || !isAllowedUrl(res.url(), base)) return undefined;
    const length = Number(res.headers()["content-length"] ?? "0");
    if (!Number.isFinite(length) || length > MAX_IDENTITY_BYTES) return undefined;
    const body = await res.body();
    if (body.length > MAX_IDENTITY_BYTES) return undefined;
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const login = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)["username"] : undefined;
    return typeof login === "string" && SIGNED_IN_AS.test(login) ? login : undefined;
  } catch {
    // fx-swallow-ok: a failed lookup means the field is left out; nothing of the response is kept
    return undefined;
  }
}
