/**
 * Signed requests to the cloud's runner routes. Every request is an RFC 9421 signature over the method, the full URI and
 * the body digest, made with the runner's own key; no cookie, token or header other than the signature is sent.
 */
import { randomBytes } from "node:crypto";
import { signRequest } from "@fulcrumaxe/runner-protocol";
import { CliError } from "./cliError.js";
import { BYPASS_ENV_NAME, bypassHeaders } from "./protectionBypass.js";
import type { RunnerKey } from "./keys.js";

export const REGISTER_PATH = "/api/runner/register";
export const REVOKE_PATH = "/api/runner/revoke";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 64 * 1024;

/** `https://host[:port]`, or `http://` only for a machine's own loopback address. Anything else is refused. */
export function normaliseOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError("--cloud-url must be an address like https://example.com", 2);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!schemeOk || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new CliError("--cloud-url must be an https address with no path (http is allowed only for localhost)", 2);
  }
  return url.origin;
}

export interface CloudReply {
  status: number;
  /** The parsed JSON body, or undefined when it was not JSON. */
  body: unknown;
  retryAfter: number | undefined;
  /** True for Vercel's own "Protected deployment" 401: the platform answered before the cloud's code ran. */
  protectedDeployment: boolean;
}

export interface SignedPost {
  origin: string;
  path: string;
  body: unknown;
  key: RunnerKey;
  now: Date;
  fetchFn: typeof fetch;
  /** The Vercel protection bypass secret, if the user set one. Sent only to `origin`; see protectionBypass.ts. */
  bypass?: string | undefined;
}

/**
 * Vercel's protection answer, as captured from a protected staging deployment: status 401, a JSON body whose `protection` object has
 * `vercel_auth_enabled: true` or whose `error.message` is "Protected deployment". Its `error.code` is the string "401", which our own
 * snake_case codes never are, but the code is not what decides. `server: Vercel` only supports a body that carries a `protection`
 * object; it never decides alone, because our own cloud also runs on Vercel and answers 401 itself (`runner_revoked`).
 */
export function isProtectedDeployment(status: number, serverHeader: string | null, body: unknown): boolean {
  if (status !== 401 || typeof body !== "object" || body === null) return false;
  const { protection, error } = body as { protection?: unknown; error?: unknown };
  const protectionObject = typeof protection === "object" && protection !== null ? (protection as { vercel_auth_enabled?: unknown }) : undefined;
  if (protectionObject?.vercel_auth_enabled === true) return true;
  if (typeof error === "object" && error !== null && (error as { message?: unknown }).message === "Protected deployment") return true;
  return serverHeader?.toLowerCase() === "vercel" && protectionObject !== undefined;
}

/** At most `max` bytes of the reply body, read chunk by chunk; the rest of the stream is cancelled unread. */
export async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - total;
      const piece = value.length > room ? value.subarray(0, room) : value;
      chunks.push(piece);
      total += piece.length;
    }
  } catch {
    throw new CliError("could not read the cloud's reply; try again");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Sends one signed POST. Network failures are reported in fixed words; a reply is returned as it came. */
export async function signedPost(input: SignedPost): Promise<CloudReply> {
  const text = JSON.stringify(input.body);
  const url = `${input.origin}${input.path}`;
  const headers = signRequest({
    method: "POST",
    url,
    body: text,
    privateKey: input.key.privateKey,
    keyid: input.key.jkt,
    nonce: randomBytes(18).toString("base64url"),
    created: Math.floor(input.now.getTime() / 1000),
  });
  let response: Response;
  try {
    response = await input.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers, ...bypassHeaders(input.bypass, input.origin, url) },
      body: text,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CliError("could not reach the cloud; check --cloud-url and your network, then try again");
  }
  const raw = await readCapped(response, MAX_REPLY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // fx-swallow-ok: a reply that is not JSON is returned as `undefined` and handled as an unexpected reply by the caller
    body = undefined;
  }
  const retry = Number(response.headers.get("retry-after"));
  return {
    status: response.status,
    body,
    retryAfter: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86_400) : undefined,
    protectedDeployment: isProtectedDeployment(response.status, response.headers.get("server"), body),
  };
}

/** The `error.code` of a refusal when it is a short lower-case word; nothing else the server says is ever shown. */
export function errorCodeOf(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown } } | undefined)?.error;
  return typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code) ? error.code : undefined;
}

const HINTS: Readonly<Record<string, string>> = {
  invalid_code: "the registration code is not valid: it may be used, expired or mistyped. Create a new one in the workspace",
  key_registered: "that key is already registered",
  runner_limit: "this account has reached its runner limit",
  invalid_key: "the cloud refused the public key",
  invalid_message: "the cloud did not accept the request; update fx-runner and try again",
  unauthorized: "the cloud does not know this runner: it was revoked or its key was replaced; run: fx-runner revoke --local, then register again",
  reregister_required: "this runner's key is more than 90 days old; run: fx-runner revoke --local, then register again",
  not_configured: "the cloud's runner API is not switched on",
  body_too_large: "the request was too large",
  nonce_reused: "the request was refused as a repeat; try again",
};

/** A fixed-text error for a refusal, with the code and, for a rate limit, the wait. */
export function refusalError(reply: CloudReply): CliError {
  const code = errorCodeOf(reply.body);
  if (reply.protectedDeployment) {
    return new CliError(`the cloud is behind Vercel Deployment Protection (401); for staging or a protected preview set ${BYPASS_ENV_NAME} to a file holding the project's Protection Bypass for Automation secret`);
  }
  if (reply.status === 429) return new CliError(`too many attempts; wait ${reply.retryAfter ?? 60} seconds and try again`);
  const hint = code ? HINTS[code] : undefined;
  return new CliError(`the cloud refused the request (${reply.status}${code ? ` ${code}` : ""})${hint ? `: ${hint}` : ""}`);
}
