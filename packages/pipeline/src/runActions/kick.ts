import { reportError } from "@fx/telemetry";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * D#2 H14c-3b: the kick endpoint's logic. The web side (packages/api's HTTP signal)
 * POSTs `{"actionId": "<uuid>"}` with `X-Fx-Kick: t=<unix seconds>,sig=<hex>`, where sig
 * is HMAC-SHA256 over `<t>.<body>` under the shared secret. The signature is the ONLY
 * authentication: a valid one within 60 s of now is accepted, anything else is a bare
 * 401 (no body, no hint which part failed).
 *
 * A valid kick answers 202 with no body whether or not the action exists, so the
 * endpoint is no oracle for ids; it then starts the workflow and never reads the row
 * itself (the workflow's claim does). The id is the server-generated request id; a
 * body that does not carry one is acknowledged and nothing is started.
 *
 * This file and packages/api's httpSignal.ts are the only two places the secret is read.
 */

export const KICK_HEADER = "x-fx-kick";
/** How far the signed timestamp may be from now, either way. */
export const KICK_MAX_SKEW_SECONDS = 60;
/** A real body is about 60 bytes; anything bigger is refused before it is hashed. */
export const KICK_MAX_BODY_CHARS = 1024;

const HEADER_RE = /^t=(\d{1,12}),sig=([0-9a-f]{64})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The hex signature for a body at a timestamp. */
export function signKick(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** True only for a well-formed header whose signature matches and whose timestamp is within the skew. Constant-time compare. */
export function verifyKick(header: string | null, body: string, secret: string, nowSeconds: number): boolean {
  if (!secret || !header || body.length > KICK_MAX_BODY_CHARS) return false;
  const m = HEADER_RE.exec(header);
  if (!m) return false;
  const timestamp = Number(m[1]);
  const expected = Buffer.from(signKick(secret, timestamp, body), "hex");
  const actual = Buffer.from(m[2]!, "hex");
  // Both are 32 bytes (the pattern fixes the length), so this never throws.
  const signatureOk = timingSafeEqual(expected, actual);
  return signatureOk && Math.abs(nowSeconds - timestamp) <= KICK_MAX_SKEW_SECONDS;
}

export interface KickDeps {
  /** The shared secret; empty fails closed. */
  secret: string;
  nowSeconds(): number;
  /** False while no worker is configured: a valid kick is then acknowledged and nothing is started. */
  configured(): boolean;
  /** Starts runActionWorkflow(actionId). */
  startWorkflow(actionId: string): Promise<void>;
}

/** The secret, from the environment. Read here and in packages/api's httpSignal.ts only. */
export function kickSecretFromEnv(): string {
  return process.env.RUN_ACTION_KICK_SECRET ?? "";
}

export function actionIdFromBody(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const id = typeof parsed === "object" && parsed !== null ? (parsed as { actionId?: unknown }).actionId : undefined;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch {
    // fx-swallow-ok: a body that is not JSON carries no action id; the caller treats null as "nothing to start"
    return null;
  }
}

/** 401 for anything unsigned, stale or forged; 202 for every valid kick. */
export async function handleKick(header: string | null, body: string, deps: KickDeps): Promise<202 | 401> {
  if (!verifyKick(header, body, deps.secret, deps.nowSeconds())) return 401;
  const actionId = actionIdFromBody(body);
  if (actionId && deps.configured()) {
    try {
      await deps.startWorkflow(actionId);
    } catch (err) {
      // The row is the durable signal; the sweep starts it if this kick could not.
      reportError(err, { stage: "run_actions.kick" });
    }
  }
  return 202;
}
