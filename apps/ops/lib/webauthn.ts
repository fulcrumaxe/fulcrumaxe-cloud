import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Pool } from "pg";
import { opsOrigin, rpIdOf } from "./env";

/**
 * Passkeys are the only way to a staff session: a WebAuthn ceremony with user verification required, against a credential of
 * an active staff member. Challenges are not stored per user; each is carried in a signed cookie that lives five minutes and
 * is spent in the database (ops_challenge_consume) the first time it is used, so a replayed challenge is refused.
 */
export const CHALLENGE_COOKIE = "__Host-fx_ops_challenge";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_AUDIENCE = "fx-ops-challenge";

type Env = Readonly<Record<string, string | undefined>>;
type Clock = () => number;

/** A ceremony that must not produce a session or an enrollment. `reason` is a short lowercase label, safe to log. */
export class WebAuthnRefusal extends Error {
  static readonly fixedMessage = "the passkey ceremony was refused";
  constructor(readonly reason: string) {
    super(WebAuthnRefusal.fixedMessage);
  }
}

export const challengeCookieAttributes = { name: CHALLENGE_COOKIE, httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: CHALLENGE_TTL_MS / 1000 } as const;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const enrollmentTokenHash = sha256;

function secretKey(env: Env): Uint8Array {
  const secret = env.FX_OPS_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new WebAuthnRefusal("not_configured");
  return new TextEncoder().encode(secret);
}

interface ChallengeClaims {
  challenge: string;
  purpose: "login" | "enroll";
  /** For enrollment: the hash of the enrollment token the options were issued for. */
  tokenHash?: string;
  jti: string;
  expiresAtMs: number;
}

async function signChallenge(c: Omit<ChallengeClaims, "jti" | "expiresAtMs">, env: Env, now: Clock): Promise<string> {
  const exp = now() + CHALLENGE_TTL_MS;
  return new SignJWT({ ch: c.challenge, p: c.purpose, ...(c.tokenHash ? { th: c.tokenHash } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(CHALLENGE_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt(Math.floor(now() / 1000))
    .setExpirationTime(Math.floor(exp / 1000))
    .sign(secretKey(env));
}

async function readChallenge(token: string | undefined, purpose: ChallengeClaims["purpose"], env: Env, now: Clock): Promise<ChallengeClaims> {
  if (!token) throw new WebAuthnRefusal("challenge_missing");
  try {
    const { payload } = await jwtVerify(token, secretKey(env), { audience: CHALLENGE_AUDIENCE, algorithms: ["HS256"], currentDate: new Date(now()) });
    if (typeof payload.ch !== "string" || payload.p !== purpose || typeof payload.jti !== "string" || typeof payload.exp !== "number") {
      throw new WebAuthnRefusal("challenge_invalid");
    }
    return { challenge: payload.ch, purpose, ...(typeof payload.th === "string" ? { tokenHash: payload.th } : {}), jti: payload.jti, expiresAtMs: payload.exp * 1000 };
  } catch (err) {
    if (err instanceof WebAuthnRefusal) throw err;
    throw new WebAuthnRefusal("challenge_invalid");
  }
}

/** Spends the challenge. False when it was spent before. */
async function consume(pool: Pool, c: ChallengeClaims): Promise<void> {
  const { rows } = await pool.query<{ ok: boolean }>("SELECT ops_challenge_consume($1, $2) AS ok", [sha256(c.jti), new Date(c.expiresAtMs)]);
  if (!rows[0]?.ok) throw new WebAuthnRefusal("challenge_replayed");
}

function ceremony(env: Env): { origin: string; rpID: string } {
  const origin = opsOrigin(env);
  if (!origin) throw new WebAuthnRefusal("not_configured");
  return { origin, rpID: rpIdOf(origin) };
}

const credentialBytes = (id: string): Buffer => Buffer.from(id, "base64url");

// ---------------------------------------------------------------- sign-in

export async function loginOptions(env: Env, now: Clock = Date.now) {
  const { rpID } = ceremony(env);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required", timeout: 60_000 });
  return { options, cookie: await signChallenge({ challenge: options.challenge, purpose: "login" }, env, now) };
}

/** Verifies the assertion and returns the staff id it belongs to. Throws WebAuthnRefusal; never returns a partial success. */
export async function loginVerify(args: { pool: Pool; env: Env; now?: Clock; challengeToken: string | undefined; response: AuthenticationResponseJSON }): Promise<{ staffId: string }> {
  const { pool, env, response } = args;
  const now = args.now ?? Date.now;
  const { origin, rpID } = ceremony(env);
  const claims = await readChallenge(args.challengeToken, "login", env, now);
  await consume(pool, claims);
  if (typeof response?.id !== "string") throw new WebAuthnRefusal("response_invalid");
  const { rows } = await pool.query<{ staff_id: string; public_key: Buffer; sign_count: string }>("SELECT staff_id, public_key, sign_count FROM ops_login_credential($1)", [credentialBytes(response.id)]);
  const row = rows[0];
  if (!row) throw new WebAuthnRefusal("unknown_credential");
  const stored = Number(row.sign_count);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claims.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: response.id, publicKey: new Uint8Array(row.public_key), counter: stored },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: "required" },
    });
  } catch {
    throw new WebAuthnRefusal("verification_failed");
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) throw new WebAuthnRefusal("uv_missing");
  const next = verified.authenticationInfo.newCounter;
  if (next > stored) {
    const bumped = await pool.query<{ ok: boolean }>("SELECT ops_login_bump_sign_count($1, $2) AS ok", [credentialBytes(response.id), next]);
    if (!bumped.rows[0]?.ok) throw new WebAuthnRefusal("counter_race");
  }
  return { staffId: row.staff_id };
}

// ------------------------------------------------------------- enrollment

export async function enrollOptions(args: { pool: Pool; env: Env; now?: Clock; token: string }) {
  const { pool, env } = args;
  const now = args.now ?? Date.now;
  const { rpID } = ceremony(env);
  const tokenHash = sha256(args.token);
  const { rows } = await pool.query<{ staff_id: string; email: string; display_name: string }>("SELECT staff_id, email, display_name FROM ops_enroll_lookup($1)", [tokenHash]);
  const staff = rows[0];
  if (!staff) throw new WebAuthnRefusal("token_invalid");
  const options = await generateRegistrationOptions({
    rpName: "fulcrumaxe operator console",
    rpID,
    userName: staff.email,
    userDisplayName: staff.display_name,
    userID: new TextEncoder().encode(staff.staff_id),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { options, cookie: await signChallenge({ challenge: options.challenge, purpose: "enroll", tokenHash }, env, now) };
}

/** Registers the one passkey the token allows. The token is spent only if the passkey verifies and is stored. */
export async function enrollVerify(args: { pool: Pool; env: Env; now?: Clock; token: string; challengeToken: string | undefined; response: RegistrationResponseJSON }): Promise<{ staffId: string }> {
  const { pool, env, response } = args;
  const now = args.now ?? Date.now;
  const { origin, rpID } = ceremony(env);
  const claims = await readChallenge(args.challengeToken, "enroll", env, now);
  const tokenHash = sha256(args.token);
  if (claims.tokenHash !== tokenHash) throw new WebAuthnRefusal("challenge_invalid");
  await consume(pool, claims);
  let verified;
  try {
    verified = await verifyRegistrationResponse({ response, expectedChallenge: claims.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch {
    throw new WebAuthnRefusal("verification_failed");
  }
  if (!verified.verified) throw new WebAuthnRefusal("verification_failed");
  const { credential } = verified.registrationInfo;
  try {
    const { rows } = await pool.query<{ staff_id: string }>("SELECT ops_enroll_complete($1, $2, $3, $4) AS staff_id", [tokenHash, credentialBytes(credential.id), Buffer.from(credential.publicKey), credential.counter]);
    return { staffId: rows[0]!.staff_id };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "42501") throw new WebAuthnRefusal("token_invalid");
    if (code === "23505") throw new WebAuthnRefusal("credential_exists");
    throw err;
  }
}
