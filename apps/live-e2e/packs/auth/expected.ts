/**
 * Pure checks for the auth pack (rows A1 and A7 signed in), written out here on purpose and not imported from
 * apps/web, so a live check does not pass just because the app changed its own constants. A violation names a field
 * or a rule, never the value (the answers carry an email and a login).
 */
import type { Hop } from "../../src/client.js";

export const SIGN_IN_PATH = "/api/auth/github";
export const CALLBACK_PATH = "/api/auth/github/callback";
export const GITHUB_AUTHORIZE_PATH = "/login/oauth/authorize";
export const GITHUB_SCOPE = "read:user user:email";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const STATE_COOKIE = "fx_oauth_state";
export const STATE_COOKIE_MAX_AGE = 600;

/**
 * A1. The state is only worth anything if the browser holds it too: the sign-in start sets a cookie with the same
 * value as the `state` sent to GitHub, and the callback compares the two. `setCookie` is every Set-Cookie header of
 * the first redirect; `state` is the one in its Location. The cookie must be HttpOnly, Secure, SameSite=Lax, Path=/,
 * host-only (no Domain) and live no longer than 600 seconds. A violation names the attribute, never the value.
 */
export function stateCookieViolations(setCookie: readonly string[], state: string): string[] {
  const raw = setCookie.find((c) => (c.split(";")[0] ?? "").trim().startsWith(`${STATE_COOKIE}=`));
  if (raw === undefined) return [`no ${STATE_COOKIE} cookie was set`];
  const [pair = "", ...attrs] = raw.split(";").map((s) => s.trim());
  const out: string[] = [];
  const value = pair.slice(pair.indexOf("=") + 1);
  if (state === "") out.push("the redirect carried no state to bind the cookie to");
  else if (value !== state) out.push(`the ${STATE_COOKIE} cookie value is not the state sent to GitHub`);
  const attr = (name: string): string | undefined => {
    const hit = attrs.find((a) => a.toLowerCase() === name || a.toLowerCase().startsWith(`${name}=`));
    if (hit === undefined) return undefined;
    const eq = hit.indexOf("=");
    return eq === -1 ? "" : hit.slice(eq + 1);
  };
  if (attr("httponly") === undefined) out.push(`the ${STATE_COOKIE} cookie is not HttpOnly`);
  if (attr("secure") === undefined) out.push(`the ${STATE_COOKIE} cookie is not Secure`);
  if ((attr("samesite") ?? "").toLowerCase() !== "lax") out.push(`the ${STATE_COOKIE} cookie is not SameSite=Lax`);
  if (attr("path") !== "/") out.push(`the ${STATE_COOKIE} cookie is not Path=/`);
  if (attr("domain") !== undefined) out.push(`the ${STATE_COOKIE} cookie has a Domain attribute`);
  const maxAge = attr("max-age");
  if (maxAge === undefined || !/^\d+$/.test(maxAge)) out.push(`the ${STATE_COOKIE} cookie has no Max-Age`);
  else if (Number(maxAge) > STATE_COOKIE_MAX_AGE) out.push(`the ${STATE_COOKIE} cookie Max-Age is over ${STATE_COOKIE_MAX_AGE} seconds`);
  return out;
}

/** True for github.com and any subdomain of it (exact host match, never a suffix test on a longer name). */
export function isGithubHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
}

/**
 * A1. The hops a client made following `/api/auth/github`: the first is a redirect on the target and carried the
 * bypass header; the first github.com hop is the authorize URL with the app's client id, a callback on the host
 * that issued the redirect, the scope and a fresh state; and no hop off the target origin carried the bypass header.
 */
export function authorizeViolations(hops: readonly Hop[], targetOrigin: string): string[] {
  const out: string[] = [];
  const first = hops[0];
  if (first === undefined || new URL(first.url).pathname !== SIGN_IN_PATH) return ["the first request was not the sign-in path"];
  if (first.status < 300 || first.status >= 400) out.push(`the sign-in path answered ${first.status}, not a redirect`);
  if (new URL(first.url).origin === new URL(targetOrigin).origin && !first.bypass) out.push("the first hop did not carry the bypass header (so this proves nothing about the redirect)");
  const gh = hops.findIndex((h) => isGithubHost(h.url));
  if (gh === -1) return [...out, "the redirect never reached github.com"];
  // Every hop off the target origin, github.com or anything it was redirected through, must be free of the bypass header.
  const target = new URL(targetOrigin).origin;
  if (hops.some((h) => new URL(h.url).origin !== target && h.bypass)) out.push("a request to another origin carried the bypass header");
  const authorize = new URL((hops[gh] as Hop).url);
  if (authorize.protocol !== "https:" || authorize.hostname !== "github.com" || authorize.pathname !== GITHUB_AUTHORIZE_PATH) {
    out.push("the first github.com request was not https://github.com/login/oauth/authorize");
  }
  const p = authorize.searchParams;
  if ((p.get("client_id") ?? "") === "") out.push("client_id is missing");
  if (p.get("scope") !== GITHUB_SCOPE) out.push("scope is not the documented one");
  if (!UUID_V4.test(p.get("state") ?? "")) out.push("state is not a fresh random identifier");
  let callback: URL | undefined;
  try {
    callback = new URL(p.get("redirect_uri") ?? "");
  } catch {
    out.push("redirect_uri is missing or not a URL");
  }
  if (callback !== undefined) {
    if (callback.pathname !== CALLBACK_PATH) out.push("redirect_uri is not the sign-in callback path");
    if (callback.protocol !== "https:") out.push("redirect_uri is not https");
    const issuer = hops[gh - 1];
    if (issuer !== undefined && new URL(issuer.url).origin !== callback.origin) out.push("redirect_uri is on a different origin than the host that issued the redirect");
  }
  return out;
}

const WORKSPACE_ACCESS = ["open", "no_subscription", "subscription_ended"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A7. `/api/cloud/auth/me` and `/api/profile` signed in: the six documented fields and an opaque id. */
export function identityViolations(body: unknown, role: "owner" | "member"): string[] {
  if (!isObject(body)) return ["body is not an object"];
  const out: string[] = [];
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "email,id,is_admin,storage_ns,username,workspace_access") out.push(`unexpected fields: ${keys}`);
  if (typeof body["username"] !== "string" || body["username"] === "") out.push("username is not a non-empty string");
  if (body["email"] !== null && typeof body["email"] !== "string") out.push("email is neither a string nor null");
  if (typeof body["id"] !== "string" || !/^[A-Za-z0-9_-]{8,}$/.test(body["id"]) || /^\d+$/.test(body["id"])) out.push("id is not an opaque identifier");
  if (typeof body["storage_ns"] !== "string" || body["storage_ns"] === "") out.push("storage_ns is not a non-empty string");
  if (typeof body["is_admin"] !== "boolean") out.push("is_admin is not a boolean");
  else if ((role === "owner") !== body["is_admin"]) out.push(`is_admin does not match the ${role} role`);
  if (!WORKSPACE_ACCESS.includes(String(body["workspace_access"]))) out.push("workspace_access is not one of the documented values");
  return out;
}

/** A7. `/api/entitlements/me`: allow exactly when the workspace is open, deny otherwise; no per-app map is sold. */
export function entitlementsViolations(body: unknown, workspaceAccess: unknown): string[] {
  if (!isObject(body)) return ["body is not an object"];
  const out: string[] = [];
  if (Object.keys(body).sort().join(",") !== "default,entitlements") out.push("unexpected fields");
  if (!isObject(body["entitlements"]) || Object.keys(body["entitlements"]).length !== 0) out.push("entitlements is not an empty map");
  const want = workspaceAccess === "open" ? "allow" : "deny";
  if (body["default"] !== want) out.push(`default is not ${want} for workspace_access ${String(workspaceAccess)}`);
  return out;
}

/** A7. `/api/plans`: each plan has the published fields; the viewer says whether the caller owns the account. */
export function plansViolations(body: unknown, role: "owner" | "member"): string[] {
  if (!isObject(body) || !Array.isArray(body["plans"])) return ["body has no plans list"];
  const out: string[] = [];
  if (body["plans"].length === 0) out.push("plans is empty");
  body["plans"].slice(0, 5).forEach((p, i) => {
    if (!isObject(p) || typeof p["id"] !== "string" || p["id"] === "") out.push(`plans[${i}].id is not a non-empty string`);
    else if (typeof p["price_usd_month"] !== "number" || typeof p["repo_limit"] !== "number") out.push(`plans[${i}] lacks a numeric price_usd_month or repo_limit`);
  });
  const viewer = body["viewer"];
  if (!isObject(viewer) || typeof viewer["is_owner"] !== "boolean" || typeof viewer["partner_billed"] !== "boolean") out.push("viewer is missing or malformed");
  else if (viewer["is_owner"] !== (role === "owner")) out.push(`viewer.is_owner does not match the ${role} role`);
  return out;
}
