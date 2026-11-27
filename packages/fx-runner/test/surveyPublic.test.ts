import { readFileSync } from "node:fs";
import path from "node:path";
import { RUNNER_ELIGIBLE_ROLES, SURVEY_ROLE, type Job } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { verifyJob } from "../src/daemon/verifyJob.js";
import { roleToolsDigest } from "../src/job/roleTools.js";
import { createRunnerClient } from "../src/daemon/client.js";
import { generateRunnerKey } from "../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../src/version.js";
import { KEYRING, NOW, jobFor, signRaw } from "./helpers/signedJob.js";

/** D#845 ON-10e1: the runner's own gate (the fourth) takes a public repo for a validly signed survey job and for nothing else. */
const SHA = "a".repeat(40);
const check = (signed: unknown) => verifyJob(signed, KEYRING, NOW);
const repo = (isPrivate: unknown): Job["repo"] => ({ ...jobFor().repo, private: isPrivate as boolean });
const survey = (isPrivate: unknown, over: Partial<Job> = {}): Job =>
  jobFor({ role: SURVEY_ROLE, task: { ...jobFor().task, kind: "survey" }, role_tools_sha256: roleToolsDigest(SURVEY_ROLE), review: { head_sha: SHA }, repo: repo(isPrivate), ...over });

describe("verifyJob and a public repository", () => {
  it("accepts a validly signed survey job with repo.private false, and the same job with true", () => {
    expect(check(signRaw(survey(false))).ok).toBe(true);
    expect(check(signRaw(survey(true))).ok).toBe(true);
  });

  it("refuses every other role with repo.private false as repo_not_private, signature good", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) {
      if (role === SURVEY_ROLE) continue;
      expect(check(signRaw(jobFor({ role, repo: repo(false) }))), role).toEqual({ ok: false, reason: "repo_not_private" });
    }
  });

  it("refuses the survey role on another task kind, and another role on the survey task kind", () => {
    expect(check(signRaw(survey(false, { task: { ...jobFor().task, kind: "advise" } })))).toEqual({ ok: false, reason: "repo_not_private" });
    expect(check(signRaw(jobFor({ task: { ...jobFor().task, kind: "survey" }, repo: repo(false) })))).toEqual({ ok: false, reason: "repo_not_private" });
  });

  it("refuses a value that is only falsy or missing, and an unsigned public survey is not run", () => {
    for (const value of [0, "false", null, undefined]) expect(check(signRaw(survey(value))), String(value)).toEqual({ ok: false, reason: "repo_not_private" });
    expect(check({ job: survey(false) })).toEqual({ ok: false, reason: "job_signature_invalid" });
  });
});

describe("the hello ladder", () => {
  it("an old cloud that refuses survey_public_v1 costs the retries of the three newest capabilities (twin_v1 and project_setup_v1 go first, ahead of it) and keeps every other capability, survey_v1 included", async () => {
    const sent: string[][] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
      sent.push(caps);
      const refuse = caps.includes("survey_public_v1");
      return new Response(JSON.stringify(refuse ? { error: { code: "invalid_message", message: "x" } } : {}), { status: refuse ? 400 : 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn });
    const answer = await client.hello({ protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox", capabilities: [...RUNNER_BUILD_CAPABILITIES] });
    expect(answer).toEqual({ kind: "ok", dropped: ["twin_v1", "project_setup_v1", "survey_public_v1"] });
    expect(sent).toHaveLength(4);
    expect(sent[3]).toEqual(RUNNER_BUILD_CAPABILITIES.filter((c) => c !== "survey_public_v1" && c !== "project_setup_v1" && c !== "twin_v1"));
    expect(sent[2]).toContain("survey_v1");
  });
});

describe("what a public survey carries and reads", () => {
  it("the job has no field that could hold a token, and its repo names owner, name and id alone", () => {
    const job = survey(false);
    expect(Object.keys(job.repo).sort()).toEqual(["id", "name", "owner", "private"]);
    expect(Object.keys(job).filter((key) => /token|credential|secret|password/i.test(key))).toEqual([]);
  });

  it("the mirror fetches branch heads only: no pull-request ref anywhere in the runner's source", () => {
    const src = path.join(__dirname, "..", "src");
    const mirror = readFileSync(path.join(src, "daemon", "mirror.ts"), "utf8");
    expect(mirror).toContain("+refs/heads/*");
    expect(mirror).not.toMatch(/refs\/pull|refs\/merge-requests/);
  });

  it("this build lists survey_public_v1", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain("survey_public_v1");
  });
});
