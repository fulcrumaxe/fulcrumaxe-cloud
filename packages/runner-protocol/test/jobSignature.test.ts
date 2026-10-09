import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Job } from "../src/job.js";
import { JobSignatureError, canonicalJson, signJob, verifyJob, type JobSignatureErrorCode } from "../src/jobSignature.js";
import { GOLDEN_JOBS, GOLDEN_KEY } from "./helpers/goldenJobs.js";
import { sampleJob } from "./helpers/sampleJob.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const NOW = new Date("2026-10-04T12:30:00Z");
const job = sampleJob() as Job;
type Loose = { [key: string]: unknown; repo: Record<string, unknown>; spec: { text: string; [key: string]: unknown }; task: Record<string, unknown>; role_card: Record<string, unknown> };

function codeOf(run: () => unknown): JobSignatureErrorCode | "returned" {
  try {
    run();
    return "returned";
  } catch (error) {
    if (!(error instanceof JobSignatureError)) throw error;
    return error.code;
  }
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x y" } })).toBe('{"a":{"c":"x y","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("does not depend on the order keys were written in", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("refuses values JSON cannot carry", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe("job signature", () => {
  it("verifies a signed job and returns it", () => {
    expect(verifyJob(signJob(job, privateKey), keyring, { now: NOW })).toEqual(job);
  });

  it("accepts a public key given as a JWK", () => {
    const jwk = publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
    expect(verifyJob(signJob(job, privateKey), { "job-key-1": jwk }, { now: NOW })).toEqual(job);
  });

  it("keeps the H07 fence markers byte for byte through sign, serialise, parse and verify", () => {
    const text = "before\r\n<<UNTRUSTED EXTERNAL CONTENT>>\n  indented   😀 \"quoted\" \\ back\n<<END UNTRUSTED>>\nafter\t";
    const signed = signJob({ ...job, spec: { ...job.spec!, text } }, privateKey);
    const wire = JSON.stringify(signed);
    const verified = verifyJob(JSON.parse(wire), keyring, { now: NOW });
    expect(verified.spec!.text).toBe(text);
    expect(Buffer.from(verified.spec!.text).equals(Buffer.from(text))).toBe(true);
  });

  it("fails with bad_signature when any single field changes", () => {
    const signed = signJob(job, privateKey);
    const changes: Array<[string, (j: Loose) => void]> = [
      ["job_id", (j) => (j.job_id = "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a12")], ["run_id", (j) => (j.run_id = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5f")],
      ["repo.id", (j) => (j.repo.id = "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e70")], ["repo.owner", (j) => (j.repo.owner = "evil")],
      ["repo.name", (j) => (j.repo.name = "other")], ["role_tools_sha256", (j) => (j.role_tools_sha256 = "c".repeat(64))], ["task.kind", (j) => (j.task.kind = "review")], ["task.prompt", (j) => (j.task.prompt += " ")], ["role_card.text", (j) => (j.role_card.text += " ")], ["continues", (j) => (j.continues = { parent_run_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5f", session_id: "s1", branch: "fx/issue-1" })], ["spec", (j) => (j.spec = null as never)],
      ["role", (j) => (j.role = "docs-writer")], ["mode", (j) => (j.mode = "verified")],
      ["spec.discussion", (j) => (j.spec.discussion = 7)], ["spec.version", (j) => (j.spec.version = 2)],
      ["spec.sha256", (j) => (j.spec.sha256 = "b".repeat(64))], ["spec.text", (j) => (j.spec.text += " ")],
      ["branch_prefix", (j) => (j.branch_prefix = "evil/")], ["model_hint", (j) => (j.model_hint = "opus")],
      ["issued_at", (j) => (j.issued_at = "2026-10-04T11:00:00.000Z")], ["expires_at", (j) => (j.expires_at = "2026-10-05T13:00:00.000Z")],
    ];
    for (const [name, change] of changes) {
      const copy = JSON.parse(JSON.stringify(signed));
      change(copy.job);
      expect(codeOf(() => verifyJob(copy, keyring, { now: NOW })), name).toBe("bad_signature");
    }
  });

  it("treats a job of another schema_version as malformed, not as signed", () => {
    const copy = JSON.parse(JSON.stringify(signJob(job, privateKey)));
    copy.job.schema_version = 2;
    expect(codeOf(() => verifyJob(copy, keyring, { now: NOW }))).toBe("malformed");
  });

  it("fails with unknown_key_id when the job names a key the runner does not trust", () => {
    const signed = signJob({ ...job, key_id: "job-key-2" }, privateKey);
    expect(codeOf(() => verifyJob(signed, keyring, { now: NOW }))).toBe("unknown_key_id");
    // Names inherited from Object.prototype are not keys.
    const proto = signJob({ ...job, key_id: "__proto__" }, privateKey);
    expect(codeOf(() => verifyJob(proto, keyring, { now: NOW }))).toBe("unknown_key_id");
  });

  it("fails with bad_signature when another key signed it", () => {
    expect(codeOf(() => verifyJob(signJob(job, other.privateKey), keyring, { now: NOW }))).toBe("bad_signature");
  });

  it("fails with expired once expires_at has passed", () => {
    const signed = signJob(job, privateKey);
    expect(codeOf(() => verifyJob(signed, keyring, { now: new Date(job.expires_at) }))).toBe("expired");
    expect(codeOf(() => verifyJob(signed, keyring, { now: new Date("2026-10-04T12:59:59Z") }))).toBe("returned");
  });

  it("fails with missing_signature when there is none", () => {
    expect(codeOf(() => verifyJob({ job }, keyring, { now: NOW }))).toBe("missing_signature");
    expect(codeOf(() => verifyJob({ job, signature: "" }, keyring, { now: NOW }))).toBe("missing_signature");
    expect(codeOf(() => verifyJob({ job, signature: null }, keyring, { now: NOW }))).toBe("missing_signature");
  });

  it("only ever throws JobSignatureError, whatever it is given", () => {
    const signed = signJob(job, privateKey);
    const junk: unknown[] = [undefined, null, 1, "x", [], {}, { job: 1, signature: "x" }, { job: {}, signature: signed.signature }, { job, signature: 5 }, { job, signature: "short" }];
    for (const value of junk) expect(["malformed", "missing_signature"], JSON.stringify(value)).toContain(codeOf(() => verifyJob(value, keyring, { now: NOW })));
  });

  it("reports a keyring entry that is not a usable key as malformed, not as a crash", () => {
    const signed = signJob(job, privateKey);
    expect(codeOf(() => verifyJob(signed, { "job-key-1": { kty: "OKP", crv: "Ed25519", x: "not-a-key" } }, { now: NOW }))).toBe("malformed");
  });

  it("signs and verifies a job with a null spec and one that continues a session", () => {
    const review = { ...job, spec: null, role: "code-reviewer", task: { ...job.task, kind: "review" } } as Job;
    expect(verifyJob(signJob(review, privateKey), keyring, { now: NOW })).toEqual(review);
    const fix = { ...job, task: { ...job.task, kind: "fix" }, continues: { parent_run_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5f", session_id: "sess_01-a.b", branch: "fx/issue-12" } } as Job;
    expect(verifyJob(signJob(fix, privateKey), keyring, { now: NOW })).toEqual(fix);
  });

  it("refuses to sign a job whose prompt or card digest does not match its text", () => {
    expect(() => signJob({ ...job, task: { ...job.task, prompt_sha256: "d".repeat(64) } }, privateKey)).toThrow(/digest/);
    expect(() => signJob({ ...job, role_card: { ...job.role_card, sha256: "d".repeat(64) } }, privateKey)).toThrow(/digest/);
  });

  it("treats a signed job for a public repo as malformed", () => {
    const copy = JSON.parse(JSON.stringify(signJob(job, privateKey)));
    copy.job.repo.private = false;
    expect(codeOf(() => verifyJob(copy, keyring, { now: NOW }))).toBe("malformed");
  });

  it("refuses to sign a job that does not match the schema", () => {
    expect(() => signJob({ ...job, role: "researcher" } as unknown as Job, privateKey)).toThrow();
  });
});

describe("job.review and the signature (D#6 R4d-4a, C33)", () => {
  const golden = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), "utf8");

  it.each(["executor", "advise", "docs-writer"] as const)("G2: the %s job's canonical JSON and signature are byte-identical to the ones made before `review` existed, and carry no review key", (name) => {
    const signed = signJob(GOLDEN_JOBS[name], GOLDEN_KEY);
    expect(canonicalJson(signed.job)).toBe(golden(`job-${name}.canonical.json`));
    expect(signed.signature).toBe(golden(`job-${name}.signature.txt`));
    expect(canonicalJson(signed.job)).not.toContain('"review"');
    expect("review" in signed.job).toBe(false);
  });

  const reviewJob = (): Job => ({ ...job, role: "code-reviewer", task: { ...job.task, kind: "review" }, review: { head_sha: "a".repeat(40) } });

  it("G3: changing review.head_sha on a signed job makes verifyJob throw JobSignatureError", () => {
    const signed = signJob(reviewJob(), privateKey);
    expect(verifyJob(signed, keyring, { now: NOW }).review).toEqual({ head_sha: "a".repeat(40) });
    const tampered = { ...signed, job: { ...signed.job, review: { head_sha: "b".repeat(40) } } };
    expect(codeOf(() => verifyJob(tampered, keyring, { now: NOW }))).toBe("bad_signature");
  });

  it("G3: removing review from, or adding it to, a signed job also fails the signature", () => {
    const signed = signJob(reviewJob(), privateKey);
    const without: Record<string, unknown> = { ...signed.job };
    delete without.review;
    expect(codeOf(() => verifyJob({ ...signed, job: without }, keyring, { now: NOW }))).toBe("bad_signature");
    const plain = signJob(job, privateKey);
    expect(codeOf(() => verifyJob({ ...plain, job: { ...plain.job, review: { head_sha: "a".repeat(40) } } }, keyring, { now: NOW }))).toBe("bad_signature");
  });
});
