import { createHash, createHmac, randomInt } from "node:crypto";
import {
  DEVICE_LINK_WARNING,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_POLL_PATH,
  DEVICE_START_PATH,
  DEVICE_USER_CODE_ALPHABET,
  DeviceApproveBody,
  DeviceDenyBody,
  DeviceLookupBody,
  DevicePollMessage,
  DeviceStartMessage,
  DeviceStartResponse,
  RegisterResponse,
  verifyDevicePop,
} from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { MAX_BODY_BYTES, RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { maxRunnersOf } from "./register.js";
import { isUsableEd25519Key } from "./strictEd25519.js";
import { signedUrl, verifyKeyBoundRequest } from "./verifyRunnerRequest.js";

/** The shortest FX_DEVICE_CODE_KEY accepted, in bytes. */
export const DEVICE_CODE_KEY_MIN_BYTES = 32;
/** Starts one address may make in an hour, and the default for all addresses together. */
export const DEVICE_START_PER_IP_PER_HOUR = 10;
export const DEVICE_START_GLOBAL_PER_HOUR_DEFAULT = 1000;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NOT_CONFIGURED = (): RunnerHttpError => new RunnerHttpError(503, "not_configured", "the device flow is not configured");

/** The key as bytes, or null when it is missing or too short. */
export function readDeviceCodeKey(env: Readonly<Record<string, string | undefined>>): Buffer | null {
  const raw = env.FX_DEVICE_CODE_KEY;
  if (typeof raw !== "string") return null;
  const key = Buffer.from(raw, "utf8");
  return key.byteLength >= DEVICE_CODE_KEY_MIN_BYTES ? key : null;
}

/** The global start limit from FX_DEVICE_FLOW_GLOBAL_PER_HOUR; anything that is not a positive whole number is the default. */
export function readDeviceGlobalLimit(env: Readonly<Record<string, string | undefined>>): number {
  const n = Number(env.FX_DEVICE_FLOW_GLOBAL_PER_HOUR);
  return Number.isInteger(n) && n >= 1 ? n : DEVICE_START_GLOBAL_PER_HOUR_DEFAULT;
}

function requireKey(deps: Pick<RunnerCloudDeps, "deviceCodeKey">): Buffer {
  let key: Buffer | null = null;
  try {
    key = deps.deviceCodeKey?.() ?? null;
  } catch {
    // fx-swallow-ok: an unreadable key is the same refusal as a missing one; the 503 below is the report
  }
  if (key === null || key.byteLength < DEVICE_CODE_KEY_MIN_BYTES) throw NOT_CONFIGURED();
  return key;
}

/** `fxrd_` and 43 characters drawn uniformly from 62, about 256 bits. Only its SHA-256 is stored. */
export function newDeviceCode(): string {
  let text = "";
  for (let i = 0; i < 43; i++) text += BASE62[randomInt(BASE62.length)];
  return `fxrd_${text}`;
}

/** Eight letters from twenty, shown as `BCDF-GHJK`: about 35 bits, so it is only ever kept as a keyed hash and only ever looked up by a signed-in person. */
export function newUserCode(): string {
  let text = "";
  for (let i = 0; i < 8; i++) text += DEVICE_USER_CODE_ALPHABET[randomInt(DEVICE_USER_CODE_ALPHABET.length)];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

export const hashDeviceCode = (code: string): string => createHash("sha256").update(code, "utf8").digest("hex");
/** HMAC-SHA256 of the code as the machine shows it. The key is the server's, so a leaked table cannot be searched offline. */
export const hashUserCode = (key: Buffer, userCode: string): string => createHmac("sha256", key).update(`user:${userCode}`, "utf8").digest("hex");
/**
 * An IPv6 client is counted by its /64, the way the per-minute limiter keys it, so a block that holds many addresses cannot spread its starts
 * across them. Anything that is not a plain eight-group literal (an IPv4 address, a zone id, a mapped address) is counted as the string it is.
 */
export function addressBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const halves = ip.split("%")[0]!.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return ip;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}
const hashAddress = (key: Buffer, ip: string): string => createHmac("sha256", key).update(`ip:${addressBucket(ip)}`, "utf8").digest("hex");

/** RFC 7638 thumbprint of an Ed25519 public key. The database computes the same value (`runner_key_thumbprint`), which a test pins. */
export const ed25519Thumbprint = (x: string): string => createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`, "utf8").digest("base64url");

/**
 * POST /api/runner/device/start. No signature: the sender proves it holds the key it presents with `pop`, a JWS over this origin, this path and the time.
 * The reply carries the secret device code (kept by the machine) and the short user code (shown to the person). The limits are the database's:
 * 10 starts an hour per address and the global figure, both counted on stored rows.
 */
export async function startDevice(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const key = requireKey(deps);
  const message = parseMessage(DeviceStartMessage, parseJsonBody(req));
  const origin = signedUrl(deps.origin, "");
  const now = deps.now?.() ?? new Date();
  if (!isUsableEd25519Key(message.public_key_jwk.x)) throw new RunnerHttpError(400, "invalid_key", "the public key is not usable");
  if (!verifyDevicePop(message.pop, message.public_key_jwk, { origin, path: DEVICE_START_PATH }, Math.floor(now.getTime() / 1000))) {
    throw new RunnerHttpError(400, "invalid_pop", "the proof of the key does not verify");
  }
  // The country is the platform's own header, for display; anything that is not two capital letters is left out.
  const country = req.headers["x-vercel-ip-country"];
  const facts = { ...message.facts, ...(typeof country === "string" && /^[A-Z]{2}$/.test(country) ? { ip_country: country } : {}) };
  const jkt = ed25519Thumbprint(message.public_key_jwk.x);
  const ipHash = hashAddress(key, req.clientIp ?? "unknown");
  const globalLimit = deps.deviceFlowGlobalPerHour?.() ?? DEVICE_START_GLOBAL_PER_HOUR_DEFAULT;

  // A unique violation on either hash means the draw collided with a live code: draw again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = newDeviceCode();
    const userCode = newUserCode();
    try {
      const { rows } = await deps.appUserPool.query<{ expires_at: Date }>("SELECT runner_device_start($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8) AS expires_at", [
        hashDeviceCode(deviceCode),
        hashUserCode(key, userCode),
        JSON.stringify({ kty: "OKP", crv: "Ed25519", x: message.public_key_jwk.x }),
        jkt,
        JSON.stringify(facts),
        ipHash,
        DEVICE_START_PER_IP_PER_HOUR,
        globalLimit,
      ]);
      const body = DeviceStartResponse.parse({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${origin}/link`,
        expires_at: rows[0]!.expires_at.toISOString(),
        interval_s: DEVICE_POLL_INTERVAL_SECONDS,
      });
      return { status: 201, body, headers: { "cache-control": "no-store" } };
    } catch (error) {
      switch (pgCode(error)) {
        case "23505":
          continue;
        case "53400":
          throw new RunnerHttpError(429, "rate_limited", "too many device codes were started; try again later");
        case "22023":
          throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
        default:
          throw error;
      }
    }
  }
  throw new RunnerHttpError(503, "code_unavailable", "could not start a code; try again");
}

/**
 * POST /api/runner/device/poll, signed by the key the code was started with. The key is looked up first, and the signature is checked before the
 * code's state is read, so an unsigned caller learns nothing about it. After the person approves, the next poll answers the registration, once.
 */
export async function pollDevice(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const message = parseMessage(DevicePollMessage, parseJsonBody(req));
  const hash = hashDeviceCode(message.device_code);
  const found = await deps.appUserPool.query<{ jkt: string; public_key_jwk: { x: string } }>("SELECT jkt, public_key_jwk FROM runner_device_key($1)", [hash]);
  const row = found.rows[0];
  // No such code and a bad signature are one answer (the same 401). A missing row returns before the signature is checked: the device code is 256 bits, so that timing gap tells a caller nothing it could use.
  const unauthorized = new RunnerHttpError(401, "unauthorized", "the request is not signed by the key this code was started with");
  if (!row) throw unauthorized;
  const verified = await verifyKeyBoundRequest(deps, DEVICE_POLL_PATH, req, { jkt: row.jkt, x: row.public_key_jwk.x });
  if (verified.keyid !== row.jkt) throw unauthorized;

  const { rows } = await deps.appUserPool.query<{ outcome: string; runner_id: string | null; account_id: string | null; credential_mode: string | null }>(
    "SELECT outcome, runner_id, account_id, credential_mode FROM runner_device_poll($1, $2, $3)",
    [hash, verified.keyid, DEVICE_POLL_INTERVAL_SECONDS],
  );
  const r = rows[0];
  switch (r?.outcome) {
    case "pending":
      return { status: 200, body: { status: "pending" }, headers: { "cache-control": "no-store" } };
    case "approved":
      return { status: 200, body: { status: "approved", registration: RegisterResponse.parse({ runner_id: r.runner_id, account_id: r.account_id, credential_mode: r.credential_mode }) }, headers: { "cache-control": "no-store" } };
    case "slow_down":
      throw new RunnerHttpError(429, "slow_down", "poll no faster than the interval", { interval_s: DEVICE_POLL_INTERVAL_SECONDS });
    case "expired":
    case "denied":
    case "consumed":
      throw new RunnerHttpError(410, r.outcome, "this code can no longer be used");
    default:
      throw unauthorized;
  }
}

// ---- the person's side (a signed-in owner or admin; apps/web and packages/api pass the verified session) ----------------------------------------

type SessionDeps = Pick<RunnerCloudDeps, "appUserPool" | "deviceCodeKey" | "maxRunners">;

/** The typed code as the person gave it: spaces, the hyphen and case do not matter. Anything that is not a well-formed code is 400 and counts as nothing. */
function typedHash(deps: SessionDeps, body: unknown, schema: typeof DeviceLookupBody | typeof DeviceApproveBody) {
  const key = requireKey(deps);
  const raw = typeof body === "object" && body !== null && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : body;
  if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).user_code === "string") {
    const letters = ((raw as Record<string, string>).user_code as string).replace(/[\s-]+/g, "").toUpperCase();
    (raw as Record<string, unknown>).user_code = letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
  }
  const parsed = parseMessage(schema, raw) as { user_code: string; name?: string };
  return { hash: hashUserCode(key, parsed.user_code), parsed };
}

function refuse(outcome: string): never {
  switch (outcome) {
    case "not_found":
      throw new RunnerHttpError(404, "code_not_found", "that code is not one we know");
    case "gone":
      throw new RunnerHttpError(410, "code_gone", "that code has expired or was already used");
    case "limited":
      throw new RunnerHttpError(429, "rate_limited", "too many wrong codes; try again in 15 minutes", { retry_after: 900 });
    case "runner_limit":
      throw new RunnerHttpError(409, "runner_limit", "this account has reached its runner limit");
    case "key_registered":
      throw new RunnerHttpError(409, "key_registered", "that machine is already registered");
    default:
      throw new RunnerHttpError(500, "internal", "internal error");
  }
}

const forbidden = (error: unknown): never => {
  if (pgCode(error) === "42501") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can link a machine");
  throw error;
};

/** The facts the machine reported, for the page to show beside the fixed warning. The code is looked up only after a person typed it. */
export async function lookupDeviceCode(deps: SessionDeps, principal: SessionPrincipal, body: unknown): Promise<RunnerHttpResponse> {
  const { hash } = typedHash(deps, body, DeviceLookupBody);
  const out = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) =>
    (await client.query<{ outcome: string; facts: unknown; expires_at: Date | null }>("SELECT outcome, facts, expires_at FROM runner_device_lookup($1)", [hash])).rows[0],
  ).catch(forbidden);
  if (out?.outcome !== "ok") return refuse(out?.outcome ?? "");
  return { status: 200, body: { facts: out.facts, expires_at: out.expires_at!.toISOString(), warning: DEVICE_LINK_WARNING }, headers: { "cache-control": "no-store" } };
}

/** Approves the code: creates the machine with no repos, in the approver's account. `confirm` must be the literal true. */
export async function approveDeviceCode(deps: SessionDeps, principal: SessionPrincipal, body: unknown): Promise<RunnerHttpResponse> {
  const { hash, parsed } = typedHash(deps, body, DeviceApproveBody);
  const out = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const plan = (await client.query<{ plan: string }>("SELECT plan FROM accounts WHERE id = $1", [principal.accountId])).rows[0]?.plan;
    const max = maxRunnersOf(deps, plan);
    return (await client.query<{ outcome: string; runner_id: string | null }>("SELECT outcome, runner_id FROM runner_device_approve($1, $2, $3)", [hash, parsed.name ?? null, max])).rows[0];
  }).catch(forbidden);
  if (out?.outcome !== "ok") return refuse(out?.outcome ?? "");
  return { status: 200, body: { runner_id: out.runner_id }, headers: { "cache-control": "no-store" } };
}

/** Cancels a pending code: it becomes denied and its machine's next poll is a 410. */
export async function denyDeviceCode(deps: SessionDeps, principal: SessionPrincipal, body: unknown): Promise<RunnerHttpResponse> {
  const { hash } = typedHash(deps, body, DeviceDenyBody);
  const outcome = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) =>
    (await client.query<{ outcome: string }>("SELECT runner_device_deny($1) AS outcome", [hash])).rows[0]?.outcome,
  ).catch(forbidden);
  if (outcome !== "ok") return refuse(outcome ?? "");
  return { status: 200, body: { denied: true }, headers: { "cache-control": "no-store" } };
}
