import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HelloMessage, JobSchema, MACHINE_ONBOARDING_MIN_PROTOCOL, RUNNER_CAPABILITIES, RUNNER_ELIGIBLE_ROLES, SURVEY_CAPABILITY, SURVEY_PUBLIC_CAPABILITY, SURVEY_ROLE, SignedJobSchema, TASK_KINDS, publicRepoAllowed, sha256Text, signJob, verifyJob } from "../src/index.js";
import { sampleJob } from "./helpers/sampleJob.js";

const SHA = "a".repeat(40);
const REPO = (isPrivate: boolean) => ({ id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: "acme", name: "widgets", private: isPrivate });
const surveyJob = (isPrivate: boolean, over: Record<string, unknown> = {}) =>
  sampleJob({ role: SURVEY_ROLE, repo: REPO(isPrivate), task: { kind: "survey", prompt: "p", prompt_sha256: sha256Text("p") }, review: { head_sha: SHA }, ...over });
const signedParses = (job: unknown): boolean => SignedJobSchema.safeParse({ job, signature: "A".repeat(86) }).success;

describe("publicRepoAllowed (D#845 ON-10e1)", () => {
  it("is true for the survey role on a survey task and for nothing else, whatever the role or task kind", () => {
    const allowed: string[] = [];
    for (const role of [...RUNNER_ELIGIBLE_ROLES, "", "unknown-role"]) for (const kind of [...TASK_KINDS, "", "other"]) if (publicRepoAllowed(role, kind)) allowed.push(`${role}/${kind}`);
    expect(allowed).toEqual([`${SURVEY_ROLE}/survey`]);
  });
});

describe("a signed job for a public repository (D#845 ON-10e1)", () => {
  it("parses for the survey role's survey task, and only with the literal false", () => {
    expect(signedParses(surveyJob(false))).toBe(true);
    expect(signedParses(surveyJob(true))).toBe(true);
    expect(JobSchema.safeParse(surveyJob("false" as never)).success).toBe(false);
  });

  it("does not parse for any other role, and a survey role cannot carry another task kind", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) {
      if (role === SURVEY_ROLE) continue;
      expect(signedParses(sampleJob({ role, repo: REPO(false), review: { head_sha: SHA } })), role).toBe(false);
    }
    expect(signedParses(surveyJob(false, { task: { kind: "advise", prompt: "p", prompt_sha256: sha256Text("p") } }))).toBe(false);
  });

  it("is never signed or verified for another role, even through the paths that do not run SignedJobSchema", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const executor = JobSchema.parse(sampleJob({ repo: REPO(false) }));
    expect(() => signJob(executor, privateKey)).toThrow(/survey/);
    const survey = JobSchema.parse(surveyJob(false));
    const signed = signJob(survey, privateKey);
    expect(verifyJob(signed, { "job-key-1": publicKey }, { now: new Date("2026-10-04T12:30:00.000Z") }).repo.private).toBe(false);
  });
});

describe("the survey_public_v1 capability (D#845 ON-10e1)", () => {
  const hello = (capabilities: string[], protocol_version = MACHINE_ONBOARDING_MIN_PROTOCOL) => ({ protocol_version, binary_version: "1.0.0", model_auth_present: false, isolation: "host_sandbox", capabilities });
  it("is on the closed list, and a hello that lists it needs survey_v1 and the onboarding protocol", () => {
    expect(RUNNER_CAPABILITIES).toContain(SURVEY_PUBLIC_CAPABILITY);
    expect(HelloMessage.safeParse(hello([SURVEY_CAPABILITY, SURVEY_PUBLIC_CAPABILITY])).success).toBe(true);
    expect(HelloMessage.safeParse(hello([SURVEY_PUBLIC_CAPABILITY])).success).toBe(false);
    expect(HelloMessage.safeParse(hello([SURVEY_CAPABILITY, SURVEY_PUBLIC_CAPABILITY], MACHINE_ONBOARDING_MIN_PROTOCOL - 1)).success).toBe(false);
  });
});
