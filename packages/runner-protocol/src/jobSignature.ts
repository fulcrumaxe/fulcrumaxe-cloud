/**
 * Ed25519 signature over a job's canonical JSON. The cloud signs; the runner verifies with the public key that
 * `key_id` names. Verification returns the job or throws a `JobSignatureError`; it never throws anything else.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { JobSchema, jobDigestMismatches, type Job, type SignedJob } from "./job.js";

export type JobSignatureErrorCode =
  | "missing_signature"
  | "malformed"
  | "unknown_key_id"
  | "bad_signature"
  | "expired";

export class JobSignatureError extends Error {
  readonly code: JobSignatureErrorCode;
  constructor(code: JobSignatureErrorCode, message: string) {
    super(message);
    this.name = "JobSignatureError";
    this.code = code;
  }
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every depth, no whitespace outside strings. The
 * bytes of every string survive a round trip, so the fence markers in `spec.text` are signed as written.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: not a finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError("canonicalJson: unsupported value");
}

/** Signs `job` with the cloud's job-signing private key. `job.key_id` must name that key. */
export function signJob(job: Job, privateKey: KeyObject): SignedJob {
  const parsed = JobSchema.parse(job);
  // A job whose digests do not match its texts is never signed: a runner would refuse it anyway.
  if (jobDigestMismatches(parsed).length > 0) throw new TypeError("signJob: a digest does not match its text");
  const signature = sign(null, Buffer.from(canonicalJson(parsed), "utf8"), privateKey).toString("base64url");
  return { job: parsed, signature };
}

/** The public keys a runner trusts for job signatures, by `key_id`. */
export type JobKeyring = Readonly<Record<string, { kty: "OKP"; crv: "Ed25519"; x: string } | KeyObject>>;

export interface VerifyJobOptions {
  /** The current time. Tests pass a fixed value. */
  now?: Date;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Verifies a signed job and returns the job. Throws `JobSignatureError` and nothing else. */
export function verifyJob(signed: unknown, keyring: JobKeyring, options: VerifyJobOptions = {}): Job {
  try {
    if (!isObject(signed)) throw new JobSignatureError("malformed", "the signed job is not an object");
    const signature = signed["signature"];
    if (signature === undefined || signature === null || signature === "") {
      throw new JobSignatureError("missing_signature", "the job carries no signature");
    }
    if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
      throw new JobSignatureError("malformed", "the signature is not a base64url Ed25519 signature");
    }
    const parsed = JobSchema.safeParse(signed["job"]);
    if (!parsed.success) throw new JobSignatureError("malformed", "the job does not match the job schema");
    const job = parsed.data;
    const entry = Object.hasOwn(keyring, job.key_id) ? keyring[job.key_id] : undefined;
    if (entry === undefined) throw new JobSignatureError("unknown_key_id", "the job names a key this runner does not trust");
    const publicKey = isKeyObject(entry) ? entry : createPublicKey({ key: entry, format: "jwk" });
    if (!verify(null, Buffer.from(canonicalJson(job), "utf8"), publicKey, Buffer.from(signature, "base64url"))) {
      throw new JobSignatureError("bad_signature", "the signature does not match the job");
    }
    const now = (options.now ?? new Date()).getTime();
    if (Date.parse(job.expires_at) <= now) throw new JobSignatureError("expired", "the job has expired");
    return job;
  } catch (error) {
    if (error instanceof JobSignatureError) throw error;
    throw new JobSignatureError("malformed", "the signed job could not be checked");
  }
}

function isKeyObject(value: unknown): value is KeyObject {
  return typeof value === "object" && value !== null && "type" in value && typeof (value as KeyObject).export === "function";
}
