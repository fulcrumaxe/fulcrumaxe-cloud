/**
 * A stand-in for the deployed app's session surface, strict about what the real one enforces and the live-e2e code
 * touches: the cookie is `__Host-fx_session` (exact name), a signed JWT (HS256 here, as the app signs) with
 * `sessionStart` and `lastSeenAt` claims; a valid session is answered 200 and re-signed with `lastSeenAt = now`,
 * set back with the app's cookie attributes; a missing, forged, idle-expired, past-the-limit or revoked session gets
 * an EMPTY 401 (`empty401` in apps/web/lib/shell/session-routes.ts); a protected deployment answers 401 with an HTML
 * body unless the request carries the bypass header (Vercel's wall). What it cannot fake: Vercel's real wall page, the
 * database-backed epoch and revocation lookups (a plain set here), cookie storage in a browser.
 */
import { createHmac } from "node:crypto";
import { ABSOLUTE_LIMIT_MS, IDLE_LIMIT_MS } from "../src/sessions.js";

const SIGNING_SECRET = "fake-app-signing-secret-for-tests-only-0123456789";
export const BYPASS_VALUE = ["bypass", "value", "for", "tests", "0001"].join("-"); // gitleaks:allow

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

/** `header` replaces the JWT header segment (a test that needs a cookie the scrub's JWT shape would not catch on its own). */
export function signSession(claims: { sid: string; sessionStart: number; lastSeenAt: number }, header?: string): string {
  const head = header ?? b64({ alg: "HS256", typ: "JWT", kid: "test" });
  const body = b64({ userId: "u1", accountId: "a1", epoch: 0, ...claims });
  return `${head}.${body}.${createHmac("sha256", SIGNING_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export class FakeApp {
  seen: Seen[] = [];
  revoked = new Set<string>();
  /** Answer every request with this status instead (an outage). */
  outage: number | undefined;
  /** GET routes of the v1 API: path to a body builder. Like the real routes they need a valid session (empty 401 otherwise). */
  api: Record<string, (url: URL) => unknown> = {};
  /** Routes that answer without a session, as `/api/health` does. */
  open: Record<string, (url: URL) => unknown> = {};
  constructor(
    readonly origin: string,
    private now: () => number,
    private protectedDeployment = true,
  ) {}

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    this.seen.push({ method: init?.method ?? "GET", url: url.href, headers });
    if (url.origin !== this.origin) return new Response("not this app", { status: 404 });
    if (this.outage !== undefined) return new Response("down", { status: this.outage });
    if (this.protectedDeployment && headers["x-vercel-protection-bypass"] !== BYPASS_VALUE) {
      return new Response("<html>Authentication Required</html>", { status: 401, headers: { "content-type": "text/html" } });
    }
    const open = this.open[url.pathname];
    if (open !== undefined) return new Response(JSON.stringify(open(url)), { status: 200, headers: { "content-type": "application/json" } });
    const route = url.pathname === "/api/cloud/auth/me" ? () => ({ login: "someone" }) : this.api[url.pathname];
    if (route === undefined) return new Response("", { status: 404 });
    const cookie = /(?:^|;\s*)__Host-fx_session=([^;]+)/.exec(headers["cookie"] ?? "")?.[1];
    const claims = cookie === undefined ? null : this.verify(cookie);
    if (claims === null) return new Response(null, { status: 401 });
    const next = signSession({ sid: claims.sid, sessionStart: claims.sessionStart, lastSeenAt: this.now() });
    const res = new Response(JSON.stringify(route(url)), { status: 200, headers: { "content-type": "application/json" } });
    res.headers.append("set-cookie", `__Host-fx_session=${next}; Path=/; Max-Age=${Math.floor(ABSOLUTE_LIMIT_MS / 1000)}; HttpOnly; Secure; SameSite=lax`);
    return res;
  };

  private verify(token: string): { sid: string; sessionStart: number; lastSeenAt: number } | null {
    const [head, body, sig] = token.split(".");
    if (head === undefined || body === undefined || sig !== createHmac("sha256", SIGNING_SECRET).update(`${head}.${body}`).digest("base64url")) return null;
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sid: string; sessionStart: number; lastSeenAt: number };
    if (this.revoked.has(c.sid)) return null;
    if (this.now() - c.lastSeenAt >= IDLE_LIMIT_MS || this.now() - c.sessionStart >= ABSOLUTE_LIMIT_MS) return null;
    return c;
  }
}
