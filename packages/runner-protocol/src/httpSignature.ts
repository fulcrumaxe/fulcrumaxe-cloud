/**
 * HTTP message signatures for runner requests: RFC 9421 with `ed25519`, a body digest in RFC 9530's
 * `content-digest` form, and RFC 7638 thumbprints as key ids. A runner signs the method, the full target URI and the
 * body digest of every request; the cloud verifies before it reads anything else. Verification understands only the
 * components it needs, refuses the rest, and reports every failure as an `HttpSignatureError`. The nonce is
 * returned to the caller, which owns replay storage.
 */
import { createHash, createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";

export type HttpSignatureErrorCode =
  | "missing_signature"
  | "malformed"
  | "unsupported"
  | "missing_component"
  | "missing_digest"
  | "digest_mismatch"
  | "unknown_key"
  | "stale"
  | "bad_signature";

export class HttpSignatureError extends Error {
  readonly code: HttpSignatureErrorCode;
  constructor(code: HttpSignatureErrorCode, message: string) {
    super(message);
    this.name = "HttpSignatureError";
    this.code = code;
  }
}

export const RUNNER_SIGNATURE_LABEL = "fx";
/** What every runner request must cover. */
export const RUNNER_COVERED_COMPONENTS = ["@method", "@target-uri", "content-digest"] as const;
/** The most a request's `created` time may differ from the verifier's clock, in either direction. */
export const MAX_CREATED_SKEW_SECONDS = 60;

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/** RFC 7638 thumbprint of an Ed25519 public key: SHA-256 over the members `crv`, `kty`, `x` in that order, base64url. */
export function jwkThumbprint(jwk: Ed25519Jwk): string {
  const canonical = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)}}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

type Body = Uint8Array | string | undefined;
const bodyBytes = (body: Body): Uint8Array => (body === undefined ? new Uint8Array(0) : typeof body === "string" ? Buffer.from(body, "utf8") : body);

/** The `content-digest` field value for a body: `sha-256=:<base64>:`. */
export function contentDigest(body: Body): string {
  return `sha-256=:${createHash("sha256").update(bodyBytes(body)).digest("base64")}:`;
}

export interface SignRequestInput {
  method: string;
  url: string;
  body?: Body;
  privateKey: KeyObject;
  /** The RFC 7638 thumbprint of the matching public key. */
  keyid: string;
  nonce: string;
  /** Seconds since the epoch. */
  created: number;
  label?: string;
}

/** The three header fields to add to a request. */
export interface SignatureHeaders {
  "content-digest": string;
  "signature-input": string;
  signature: string;
}

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

export function signRequest(input: SignRequestInput): SignatureHeaders {
  const label = input.label ?? RUNNER_SIGNATURE_LABEL;
  if (!TOKEN.test(label) || !TOKEN.test(input.keyid) || !TOKEN.test(input.nonce) || !Number.isInteger(input.created)) {
    throw new HttpSignatureError("malformed", "signRequest: label, keyid, nonce or created is not usable");
  }
  const digest = contentDigest(input.body);
  const params = `(${RUNNER_COVERED_COMPONENTS.map((c) => `"${c}"`).join(" ")});created=${input.created};keyid="${input.keyid}";nonce="${input.nonce}";alg="ed25519"`;
  const base = buildBase(RUNNER_COVERED_COMPONENTS, params, { method: input.method, url: input.url, headers: { "content-digest": digest } });
  const signature = sign(null, Buffer.from(base, "utf8"), input.privateKey).toString("base64");
  return { "content-digest": digest, "signature-input": `${label}=${params}`, signature: `${label}=:${signature}:` };
}

export interface VerifiableRequest {
  method: string;
  /** The absolute URI the client addressed, as the verifier reconstructs it. */
  url: string;
  /** Header fields by lower-case name. */
  headers: Readonly<Record<string, string | undefined>>;
  body?: Body;
}

export type ResolvedKey = Ed25519Jwk | KeyObject | undefined;

export interface VerifyOptions {
  /** Looks a key up by the signature's `keyid`. Return nothing for an unknown key. */
  resolveKey: (keyid: string) => ResolvedKey | Promise<ResolvedKey>;
  /** The current time. Tests pass a fixed value. */
  now?: Date;
  /** Components the signature must cover. */
  requiredComponents?: readonly string[];
  /** Pick this signature when the request carries several. */
  label?: string;
  /** Require a `nonce` parameter (base64url, 16 to 64 characters). */
  requireNonce?: boolean;
  /** Require the `keyid` to equal the RFC 7638 thumbprint of the resolved key. */
  keyidIsThumbprint?: boolean;
}

export interface VerifiedSignature {
  label: string;
  keyid: string;
  created: number;
  nonce: string | undefined;
  components: readonly string[];
}

/** Splits a structured-field dictionary into [key, raw value] pairs, honouring quotes, parentheses and byte sequences. */
function splitDictionary(text: string): Array<[string, string]> {
  const members: Array<[string, string]> = [];
  let depth = 0;
  let inString = false;
  let inBytes = false;
  let start = 0;
  const flush = (end: number): void => {
    const member = text.slice(start, end).trim();
    const eq = member.indexOf("=");
    if (eq <= 0) throw new HttpSignatureError("malformed", "a dictionary member has no value");
    members.push([member.slice(0, eq), member.slice(eq + 1)]);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (inBytes) {
      if (ch === ":") inBytes = false;
    } else if (ch === '"') inString = true;
    else if (ch === ":") inBytes = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  if (inString || inBytes || depth !== 0) throw new HttpSignatureError("malformed", "unbalanced structured field");
  flush(text.length);
  return members;
}

interface ParsedParams {
  components: string[];
  created: number | undefined;
  keyid: string | undefined;
  nonce: string | undefined;
  alg: string | undefined;
}

const INNER_LIST = /^\(((?:"[^"\\]+"(?: "[^"\\]+")*)?)\)((?:;[a-z][a-z0-9_-]*(?:=(?:"[^"\\]*"|-?[0-9]{1,15}))?)*)$/;

function parseSignatureParams(raw: string): ParsedParams {
  const match = INNER_LIST.exec(raw);
  if (!match) throw new HttpSignatureError("malformed", "the signature input is not an inner list with simple parameters");
  const components = match[1] ? match[1].split(" ").map((c) => c.slice(1, -1)) : [];
  if (new Set(components).size !== components.length) throw new HttpSignatureError("malformed", "a component is covered twice");
  const out: ParsedParams = { components, created: undefined, keyid: undefined, nonce: undefined, alg: undefined };
  const seen = new Set<string>();
  for (const part of (match[2] ?? "").split(";").slice(1)) {
    const eq = part.indexOf("=");
    const name = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? "" : part.slice(eq + 1);
    if (seen.has(name)) throw new HttpSignatureError("malformed", "a signature parameter is repeated");
    seen.add(name);
    const text = value.startsWith('"') ? value.slice(1, -1) : undefined;
    if (name === "created") out.created = /^-?[0-9]+$/.test(value) ? Number(value) : undefined;
    else if (name === "keyid") out.keyid = text;
    else if (name === "nonce") out.nonce = text;
    else if (name === "alg") out.alg = text;
  }
  return out;
}

type Covered = Pick<VerifiableRequest, "method" | "url" | "headers">;

/** The value of one covered component (RFC 9421 section 2) for the components this module supports. */
function componentValue(name: string, request: Covered): string {
  if (name !== name.toLowerCase()) throw new HttpSignatureError("malformed", "component names are lower-case");
  if (name.startsWith("@")) {
    if (name === "@method") return request.method;
    if (name === "@target-uri") return request.url;
    if (name !== "@authority" && name !== "@path") throw new HttpSignatureError("unsupported", `component ${name} is not supported`);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new HttpSignatureError("malformed", "the request URL is not absolute");
    }
    return name === "@authority" ? url.host.toLowerCase() : url.pathname || "/";
  }
  const value = request.headers[name];
  if (value === undefined) throw new HttpSignatureError(name === "content-digest" ? "missing_digest" : "missing_component", `the request has no ${name} field`);
  if (/[\r\n]/.test(value)) throw new HttpSignatureError("malformed", `${name} holds a line break`);
  return value.trim();
}

function buildBase(components: readonly string[], rawParams: string, request: Covered): string {
  return [...components.map((name) => `"${name}": ${componentValue(name, request)}`), `"@signature-params": ${rawParams}`].join("\n");
}

function checkDigest(header: string, body: Body): void {
  const want = createHash("sha256").update(bodyBytes(body)).digest();
  const member = splitDictionary(header).find(([algorithm]) => algorithm === "sha-256");
  if (!member) throw new HttpSignatureError("unsupported", "content-digest has no sha-256 member");
  const m = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(member[1]);
  if (!m) throw new HttpSignatureError("malformed", "content-digest is not a byte sequence");
  const got = Buffer.from(m[1]!, "base64");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpSignatureError("digest_mismatch", "the body does not match its content-digest");
}

/** Verifies the request's signature. Resolves with the signature's details or rejects with an `HttpSignatureError`. */
export async function verifyRequestSignature(request: VerifiableRequest, options: VerifyOptions): Promise<VerifiedSignature> {
  try {
    return await verifyInner(request, options);
  } catch (error) {
    if (error instanceof HttpSignatureError) throw error;
    throw new HttpSignatureError("malformed", "the request signature could not be checked");
  }
}

async function verifyInner(request: VerifiableRequest, options: VerifyOptions): Promise<VerifiedSignature> {
  const inputHeader = request.headers["signature-input"];
  const signatureHeader = request.headers["signature"];
  if (!inputHeader || !signatureHeader) throw new HttpSignatureError("missing_signature", "the request is not signed");

  const inputs = splitDictionary(inputHeader);
  const label = options.label ?? (inputs.length === 1 ? inputs[0]![0] : undefined);
  if (label === undefined) throw new HttpSignatureError("malformed", "several signatures and no label to choose by");
  const rawParams = inputs.find(([key]) => key === label)?.[1];
  const rawSignature = splitDictionary(signatureHeader).find(([key]) => key === label)?.[1];
  if (rawParams === undefined || rawSignature === undefined) throw new HttpSignatureError("missing_signature", `no signature labelled ${label}`);
  const sigMatch = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(rawSignature);
  if (!sigMatch) throw new HttpSignatureError("malformed", "the signature is not a byte sequence");

  const params = parseSignatureParams(rawParams);
  for (const required of options.requiredComponents ?? []) {
    if (!params.components.includes(required)) {
      throw new HttpSignatureError(required === "content-digest" ? "missing_digest" : "missing_component", `the signature does not cover ${required}`);
    }
  }
  if (params.alg !== undefined && params.alg !== "ed25519") throw new HttpSignatureError("unsupported", "only ed25519 is accepted");
  if (params.keyid === undefined || params.created === undefined) throw new HttpSignatureError("malformed", "the signature has no keyid or created time");
  if (options.requireNonce && (params.nonce === undefined || !/^[A-Za-z0-9_-]{16,64}$/.test(params.nonce))) {
    throw new HttpSignatureError("malformed", "the signature has no usable nonce");
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - params.created) > MAX_CREATED_SKEW_SECONDS) throw new HttpSignatureError("stale", "the signature's created time is too far from now");

  const resolved = await options.resolveKey(params.keyid);
  if (resolved === undefined) throw new HttpSignatureError("unknown_key", "no key for this keyid");
  const key = "type" in resolved && typeof resolved.export === "function" ? (resolved as KeyObject) : createPublicKey({ key: { ...(resolved as Ed25519Jwk) }, format: "jwk" });
  if (options.keyidIsThumbprint) {
    const jwk = key.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string };
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || jwkThumbprint(jwk as Ed25519Jwk) !== params.keyid) {
      throw new HttpSignatureError("unknown_key", "the keyid is not this key's thumbprint");
    }
  }
  if (params.components.includes("content-digest")) {
    const header = request.headers["content-digest"];
    if (header === undefined) throw new HttpSignatureError("missing_digest", "the request has no content-digest field");
    checkDigest(header, request.body);
  }
  const base = buildBase(params.components, rawParams, request);
  if (!verify(null, Buffer.from(base, "utf8"), key, Buffer.from(sigMatch[1]!, "base64"))) {
    throw new HttpSignatureError("bad_signature", "the signature does not match the request");
  }
  return { label, keyid: params.keyid, created: params.created, nonce: params.nonce, components: params.components };
}

/** The checks every runner request goes through. */
export function verifyRunnerRequest(request: VerifiableRequest, resolveKey: VerifyOptions["resolveKey"], now?: Date): Promise<VerifiedSignature> {
  return verifyRequestSignature(request, {
    resolveKey,
    ...(now ? { now } : {}),
    requiredComponents: RUNNER_COVERED_COMPONENTS,
    label: RUNNER_SIGNATURE_LABEL,
    requireNonce: true,
    keyidIsThumbprint: true,
  });
}
