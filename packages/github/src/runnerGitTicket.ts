import { randomUUID, type KeyObject } from "node:crypto";
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK, type JWTVerifyGetKey } from "jose";

/**
 * D#6 R5a-2b (correction C27 section 1): the git ticket. The cloud signs a short-lived compact JWS (EdDSA, Ed25519) that names ONE run, ONE
 * lease generation, ONE repository and ONE branch; the GitHub proxy checks it with a public key and no database. This module is the only
 * place that knows the ticket's shape: `signRunnerGitTicket` (apps/web's worker) and `verifyRunnerGitTicket` (the proxy) both live here so
 * the two sides cannot drift apart.
 *
 * The ticket is a bearer token for at most 5 minutes (plus 60 s of clock skew) and is NOT single-use, because one git command makes several
 * HTTP requests. What bounds a stolen one is not in this file: the proxy re-checks the lease in the database on every request, and the
 * runner policy lets a ticket push only the one branch it names.
 *
 * The claims are a strict set. A token with a claim not listed here is refused, as is one whose branch is not a run branch.
 */

/** The `typ` header of a git ticket. Another `typ` (a sandbox OIDC token, a plain JWT) is refused before any claim is read. */
export const GIT_TICKET_TYP = "fx-git-ticket+jwt";
/** A ticket lives this long from `iat`. Fixed: the verifier refuses any other span. */
export const GIT_TICKET_LIFETIME_SECONDS = 300;
/** The clock skew the verifier allows, equal to the signed-request skew bound (`MAX_CREATED_SKEW_SECONDS`, a test pins that the two match). */
export const GIT_TICKET_CLOCK_TOLERANCE_SECONDS = 60;
/** No ticket older than this (lifetime plus skew plus a minute for the second the clock is read in) is ever honoured. */
export const GIT_TICKET_MAX_AGE_SECONDS = 360;
/** The most keys a ticket JWKS may hold: the current one and the one being retired. Old tickets die within their 5 minutes. */
export const GIT_TICKET_MAX_JWKS_KEYS = 2;

/** The one branch shape a ticket may name: `fx/<run id>-g<generation>`. The same shape the cloud's `RUNNER_RUN_BRANCH` pins. */
export const GIT_TICKET_REF_PATTERN = /^fx\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-g[1-9][0-9]*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export interface GitTicketRepo {
  /** `repos.id`. */
  id: string;
  /** GitHub owner login. */
  owner: string;
  /** GitHub repository name. */
  name: string;
}

/** The verified claims of a git ticket, under the names the code uses (the wire names are `sub`, `acct`, `run`, `gen`). */
export interface RunnerGitTicketClaims {
  issuer: string;
  audience: string;
  runnerId: string;
  accountId: string;
  runId: string;
  leaseGeneration: number;
  repo: GitTicketRepo;
  ref: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

export type RunnerGitTicketErrorCode = "malformed" | "header" | "signature" | "issuer" | "audience" | "expired" | "claims";

/** A refused ticket. The message is fixed text: it never echoes the token or a claim, so it is safe to log. */
export class RunnerGitTicketError extends Error {
  readonly code: RunnerGitTicketErrorCode;
  constructor(code: RunnerGitTicketErrorCode) {
    super(`runnerGitTicket: refused (${code})`);
    this.name = "RunnerGitTicketError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function validRepo(value: unknown): GitTicketRepo | null {
  if (!isRecord(value) || Object.keys(value).sort().join() !== "id,name,owner") return null;
  const { id, owner, name } = value;
  if (typeof id !== "string" || !UUID.test(id) || typeof owner !== "string" || !OWNER.test(owner) || typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") return null;
  return { id, owner, name };
}

const WIRE_CLAIMS = ["acct", "aud", "exp", "gen", "iat", "iss", "jti", "nbf", "ref", "repo", "run", "sub"].join();

/**
 * The strict claims schema. Exactly the twelve wire claims, each of its shape; `nbf` equals `iat` and `exp` is `iat + 300`. Returns null for
 * anything else, including an extra claim. The `iss`/`aud` equality checks are the verifier's (they need the expected values).
 */
export function parseRunnerGitTicketClaims(payload: unknown): RunnerGitTicketClaims | null {
  if (!isRecord(payload) || Object.keys(payload).sort().join() !== WIRE_CLAIMS) return null;
  const { iss, aud, sub, acct, run, gen, ref, jti, iat, nbf, exp } = payload;
  const repo = validRepo(payload["repo"]);
  if (typeof iss !== "string" || iss === "" || typeof aud !== "string" || aud === "" || repo === null) return null;
  if (typeof sub !== "string" || !UUID.test(sub) || typeof acct !== "string" || !UUID.test(acct) || typeof run !== "string" || !UUID.test(run)) return null;
  if (!isSafeInt(gen) || gen < 1 || typeof ref !== "string" || !GIT_TICKET_REF_PATTERN.test(ref) || typeof jti !== "string" || !UUID.test(jti)) return null;
  if (!isSafeInt(iat) || iat < 1 || nbf !== iat || exp !== iat + GIT_TICKET_LIFETIME_SECONDS) return null;
  // The branch is not required to carry this run's id: a fix round pushes the branch of the pull request it fixes (`branchOf`), which is an earlier run's.
  return { issuer: iss, audience: aud, runnerId: sub, accountId: acct, runId: run, leaseGeneration: gen, repo, ref, jti, issuedAt: iat, expiresAt: exp };
}

export interface RunnerGitTicketSigner {
  /** The `kid` the proxy finds the public key by. */
  keyId: string;
  /** The Ed25519 private key. Held by the web tier only; the proxy has the public half. */
  privateKey: KeyObject;
}

export interface RunnerGitTicketInput {
  /** The cloud origin (`new URL(FX_APP_ORIGIN).origin`). */
  issuer: string;
  /** The proxy audience, computed by the caller from the one audience function (the worker composition root passes it in). */
  audience: string;
  runnerId: string;
  accountId: string;
  runId: string;
  leaseGeneration: number;
  repo: GitTicketRepo;
  /** The one branch the run may push: `branchOf(job, lease)`, computed from the cloud's own rows. */
  ref: string;
}

/**
 * Signs a ticket. Throws `RunnerGitTicketError("claims")` for an input the verifier would refuse (a branch outside the run-branch shape, a
 * generation below 1, a bad id), so a ticket the proxy could never accept is never handed out.
 */
export async function signRunnerGitTicket(input: RunnerGitTicketInput, signer: RunnerGitTicketSigner, now: Date): Promise<{ ticket: string; expiresAt: Date }> {
  if (!KEY_ID.test(signer.keyId)) throw new RunnerGitTicketError("header");
  const iat = Math.floor(now.getTime() / 1000);
  const payload = {
    iss: input.issuer,
    aud: input.audience,
    sub: input.runnerId,
    acct: input.accountId,
    run: input.runId,
    gen: input.leaseGeneration,
    repo: { id: input.repo.id, owner: input.repo.owner, name: input.repo.name },
    ref: input.ref,
    jti: randomUUID(),
    iat,
    nbf: iat,
    exp: iat + GIT_TICKET_LIFETIME_SECONDS,
  };
  if (parseRunnerGitTicketClaims(payload) === null) throw new RunnerGitTicketError("claims");
  const ticket = await new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", typ: GIT_TICKET_TYP, kid: signer.keyId }).sign(signer.privateKey);
  return { ticket, expiresAt: new Date((iat + GIT_TICKET_LIFETIME_SECONDS) * 1000) };
}

/**
 * The key resolver for the proxy's `FX_GIT_TICKET_PUBLIC_JWKS`: a JWKS of at most two Ed25519 public keys, each with a `kid`, none with a private
 * member. The token's `kid` picks the key; a token with no `kid`, or one not listed, finds none. Returns null for a value that is not such a set.
 */
export function createRunnerGitTicketKeys(jwks: unknown): JWTVerifyGetKey | null {
  if (!isRecord(jwks) || !Array.isArray(jwks["keys"])) return null;
  const keys = jwks["keys"] as unknown[];
  if (keys.length < 1 || keys.length > GIT_TICKET_MAX_JWKS_KEYS) return null;
  const seen = new Set<string>();
  for (const key of keys) {
    if (!isRecord(key) || key["kty"] !== "OKP" || key["crv"] !== "Ed25519" || typeof key["x"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key["x"])) return null;
    if (typeof key["kid"] !== "string" || !KEY_ID.test(key["kid"]) || seen.has(key["kid"])) return null;
    // Only these members are allowed, so a private member (`d`) or anything this check does not know means the value was not made for the proxy.
    if (Object.keys(key).some((member) => !["kty", "crv", "x", "kid", "alg", "use"].includes(member))) return null;
    if (key["alg"] !== undefined && key["alg"] !== "EdDSA") return null;
    seen.add(key["kid"]);
  }
  return createLocalJWKSet({ keys: keys as JWK[] });
}

export interface RunnerGitTicketVerifyDeps {
  /** From `createRunnerGitTicketKeys`. */
  keys: JWTVerifyGetKey;
  /** The cloud origin the ticket must name as `iss`. */
  issuer: string;
  /** The audience the ticket must name, as a JSON string (an array is refused). */
  audience: string;
  /** Tests inject the clock. */
  now?: () => Date;
}

/**
 * Verifies a ticket and returns its claims, or throws `RunnerGitTicketError` and nothing else. In order: the header (`alg` EdDSA, `typ`, a
 * `kid`), the signature against the key that `kid` names, the issuer, the audience (a string equal to the expected one), `exp`/`nbf`
 * with 60 s of tolerance, a token age of at most 360 s, then the strict claims schema. There is no database in it.
 */
export async function verifyRunnerGitTicket(token: string, deps: RunnerGitTicketVerifyDeps): Promise<RunnerGitTicketClaims> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) throw new RunnerGitTicketError("malformed");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new RunnerGitTicketError("malformed");
  }
  if (header.alg !== "EdDSA" || header.typ !== GIT_TICKET_TYP || typeof header.kid !== "string" || header.kid === "") throw new RunnerGitTicketError("header");

  let payload: unknown;
  try {
    const result = await jwtVerify(token, deps.keys, {
      algorithms: ["EdDSA"],
      typ: GIT_TICKET_TYP,
      issuer: deps.issuer,
      audience: deps.audience,
      clockTolerance: GIT_TICKET_CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: GIT_TICKET_MAX_AGE_SECONDS,
      currentDate: (deps.now ?? (() => new Date()))(),
    });
    payload = result.payload;
  } catch (error) {
    // By `.code`, never `.name`: a bundler renames classes, and the codes are literal strings that survive minification.
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (code === "ERR_JWT_EXPIRED") throw new RunnerGitTicketError("expired");
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (error as Error & { claim?: unknown }).claim;
      throw new RunnerGitTicketError(claim === "iss" ? "issuer" : claim === "aud" ? "audience" : claim === "exp" || claim === "nbf" || claim === "iat" ? "expired" : "header");
    }
    throw new RunnerGitTicketError("signature");
  }
  // An array `aud` that merely contains the expected value is refused: the ticket names one audience.
  if (!isRecord(payload) || typeof payload["aud"] !== "string") throw new RunnerGitTicketError("audience");
  const claims = parseRunnerGitTicketClaims(payload);
  if (claims === null) throw new RunnerGitTicketError("claims");
  return claims;
}
