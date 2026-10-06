import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Text, verifyJob, type Job } from "@fulcrumaxe/runner-protocol";
import { JOB_KEY_ID_ENV, JOB_SIGNING_KEY_ENV, JobSignerConfigError, loadJobSigner } from "../src/jobSigner.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const HERE = path.dirname(fileURLToPath(import.meta.url));

const JOB = {
  schema_version: 1, job_id: "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11", run_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e",
  repo: { id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: "acme", name: "widgets", private: true }, role: "executor", mode: "local", spec: null,
  task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") }, role_card: { text: "c", sha256: sha256Text("c") }, role_tools_sha256: "a".repeat(64), continues: null,
  branch_prefix: "fx/", model_hint: null, issued_at: "2026-10-04T12:00:00.000Z", expires_at: "2026-10-04T13:00:00.000Z", key_id: "x",
} as Job;

/**
 * The same fixture table as apps/web/test/env-check.test.ts ("agreement fixtures"): the env manifest check and this loader must
 * accept and refuse exactly the same values. Change one table and the other must change with it.
 */
describe("loadJobSigner: agreement fixtures (the same table as the env manifest check)", () => {
  const ed = PEM;
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const oneLine = (pem: string): string => pem.trim().replace(/\n/g, "\\n");
  const KEYS: Array<[string, string, boolean]> = [
    ["an Ed25519 key", ed, true],
    ["an Ed25519 key with literal backslash-n", oneLine(ed), true],
    ["an Ed25519 key with surrounding whitespace", `\n  ${ed}  \n`, true],
    ["an RSA key", rsa, false],
    ["an RSA key with literal backslash-n", oneLine(rsa), false],
    ["a truncated key", ed.slice(0, ed.length - 40), false],
    ["text that is not a key", "plain text", false],
  ];
  const loads = (env: Record<string, string>): boolean => {
    try {
      return loadJobSigner(env) !== null;
    } catch {
      return false;
    }
  };
  for (const [label, pem, ok] of KEYS) {
    it(`key: ${label} is ${ok ? "accepted" : "refused"}`, () => {
      expect(loads({ [JOB_SIGNING_KEY_ENV]: pem, [JOB_KEY_ID_ENV]: "signer-1" })).toBe(ok);
    });
  }

  const IDS: Array<[string, boolean]> = [["job-signer-1", true], ["A.b_c-9", true], ["x".repeat(64), true], ["x".repeat(65), false], ["has space", false], ["a/b", false], ["a:b", false], ["ünï", false]];
  for (const [id, ok] of IDS) {
    it(`signer id ${JSON.stringify(id.length > 20 ? `${id.length} chars` : id)} is ${ok ? "accepted" : "refused"}`, () => {
      expect(loads({ [JOB_SIGNING_KEY_ENV]: PEM, [JOB_KEY_ID_ENV]: id })).toBe(ok);
    });
  }
});

describe("loadJobSigner (D#6 R3b)", () => {
  it("neither setting: no signer, so a runner run cannot be dispatched", () => {
    expect(loadJobSigner({})).toBeNull();
    expect(loadJobSigner({ [JOB_SIGNING_KEY_ENV]: "  ", [JOB_KEY_ID_ENV]: "" })).toBeNull();
  });

  it("both settings: a signer whose jobs verify with the matching public key and carry the configured key id", () => {
    const signer = loadJobSigner({ [JOB_SIGNING_KEY_ENV]: PEM, [JOB_KEY_ID_ENV]: "job-key-1" })!;
    expect(signer.keyId).toBe("job-key-1");
    const signed = signer.sign(JOB);
    expect(verifyJob(signed, { "job-key-1": publicKey }, { now: new Date("2026-10-04T12:30:00Z") }).key_id).toBe("job-key-1");
  });

  it("accepts a PEM whose newlines were stored as the two characters backslash-n", () => {
    const signer = loadJobSigner({ [JOB_SIGNING_KEY_ENV]: PEM.trim().replace(/\n/g, "\\n"), [JOB_KEY_ID_ENV]: "k" });
    expect(signer).not.toBeNull();
  });

  it("exactly one setting is an error naming the missing variable", () => {
    expect(() => loadJobSigner({ [JOB_SIGNING_KEY_ENV]: PEM })).toThrow(new JobSignerConfigError(JOB_KEY_ID_ENV, "missing"));
    expect(() => loadJobSigner({ [JOB_KEY_ID_ENV]: "k" })).toThrow(new JobSignerConfigError(JOB_SIGNING_KEY_ENV, "missing"));
  });

  it("a bad key id, a key that is not a PEM and a key of another type are errors, and no message carries the key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const [env, variable] of [
      [{ [JOB_SIGNING_KEY_ENV]: PEM, [JOB_KEY_ID_ENV]: "has space" }, JOB_KEY_ID_ENV],
      [{ [JOB_SIGNING_KEY_ENV]: PEM, [JOB_KEY_ID_ENV]: "x".repeat(65) }, JOB_KEY_ID_ENV],
      [{ [JOB_SIGNING_KEY_ENV]: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----", [JOB_KEY_ID_ENV]: "k" }, JOB_SIGNING_KEY_ENV],
      [{ [JOB_SIGNING_KEY_ENV]: rsa, [JOB_KEY_ID_ENV]: "k" }, JOB_SIGNING_KEY_ENV],
    ] as const) {
      let error: unknown;
      try { loadJobSigner(env); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(JobSignerConfigError);
      expect((error as JobSignerConfigError).variable).toBe(variable);
      expect(String((error as Error).message)).not.toContain("nope");
      expect(String((error as Error).message)).not.toContain(PEM.slice(30, 60));
    }
  });
});

describe("the key is read in one place (D#6 R3b)", () => {
  /** Every source file under packages that mentions the signing-key variable, other than tests. */
  function filesMentioning(dir: string, needle: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "test" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) filesMentioning(full, needle, out);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && readFileSync(full, "utf8").includes(needle)) out.push(path.relative(path.join(HERE, "..", ".."), full));
    }
    return out;
  }

  it("only the worker's jobSigner.ts names the signing-key variable under packages (packages/runner/src does not)", () => {
    const hits = filesMentioning(path.join(HERE, "..", ".."), "FX_RUNNER_JOB_SIGNING_KEY_PEM").sort();
    expect(hits).toEqual(["worker/src/jobSigner.ts"]);
  });
});
