import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { canonicalJson, signJob, sha256Text, type Job, type JobKeyring, type SignedJob } from "@fulcrumaxe/runner-protocol";
import { roleToolsDigest } from "../../src/job/roleTools.js";

export const KEY_ID = "test-key-1";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
/** The runner's pinned keyring in tests: the one public key that `signedJob` signs with. */
export const KEYRING: JobKeyring = { [KEY_ID]: jwk };
export const OTHER_KEYRING: JobKeyring = { [KEY_ID]: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string } };

export const NOW = new Date("2026-10-08T12:00:00.000Z");

/** A job that parses, with every digest matching its text. */
export function jobFor(over: Partial<Job> = {}): Job {
  const prompt = "Implement the change.\n";
  const card = "You are the executor.\n";
  return {
    schema_version: 1,
    job_id: randomUUID(),
    run_id: randomUUID(),
    repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true },
    role: "executor",
    mode: "local",
    spec: null,
    task: { kind: "implement", prompt, prompt_sha256: sha256Text(prompt) },
    role_card: { text: card, sha256: sha256Text(card) },
    role_tools_sha256: roleToolsDigest("executor"),
    continues: null,
    branch_prefix: "fx/",
    model_hint: null,
    issued_at: "2026-10-08T11:00:00.000Z",
    expires_at: "2026-10-11T11:00:00.000Z",
    key_id: KEY_ID,
    ...over,
  };
}

/** Signs with the cloud's test key; refuses a job whose digests do not match, like the cloud does. */
export function signedJob(over: Partial<Job> = {}): SignedJob {
  return signJob(jobFor(over), privateKey);
}

/** Signs whatever it is given, with the test key: the way to get a validly signed job the cloud would never have signed. */
export function signRaw(job: unknown, key: KeyObject = privateKey): { job: unknown; signature: string } {
  return { job, signature: sign(null, Buffer.from(canonicalJson(job), "utf8"), key).toString("base64url") };
}
