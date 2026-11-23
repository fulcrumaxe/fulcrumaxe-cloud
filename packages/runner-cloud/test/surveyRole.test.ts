import { describe, expect, it } from "vitest";
import { SURVEY_ROLE, SignedJobSchema } from "@fulcrumaxe/runner-protocol";
import { RUNNER_PUSHING_ROLES } from "@fx/gh-policy";

/** D#845 ON-10a: a survey run only reads. The cloud's `done` judges a run of a pushing role by its branch and pull request; the survey role is never one, so its answer is read as a draft and nothing is opened. */
describe("the survey role on the cloud side", () => {
  it("is not a pushing role, so `done` never looks for a branch or opens a pull request for it", () => {
    expect(RUNNER_PUSHING_ROLES.has(SURVEY_ROLE)).toBe(false);
    expect([...RUNNER_PUSHING_ROLES].sort()).toEqual(["docs-writer", "executor"]);
  });

  it("the signed job schema keeps the role and the survey kind together (the cloud parses its own stored job with it)", () => {
    const job = (role: string, kind: string) => ({ schema_version: 1, job_id: "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11", run_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", repo: { id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: "acme", name: "widgets", private: true }, role, mode: "local", spec: null, task: { kind, prompt: "p", prompt_sha256: "0".repeat(64) }, role_card: { text: "c", sha256: "0".repeat(64) }, role_tools_sha256: "a".repeat(64), continues: null, review: { head_sha: "c".repeat(40) }, branch_prefix: "fx/", model_hint: null, issued_at: "2026-10-04T12:00:00.000Z", expires_at: "2026-10-04T13:00:00.000Z", key_id: "k1" });
    const parses = (role: string, kind: string) => SignedJobSchema.safeParse({ job: job(role, kind), signature: "A".repeat(86) }).success;
    expect(parses(SURVEY_ROLE, "survey")).toBe(true);
    expect(parses(SURVEY_ROLE, "implement")).toBe(false);
    expect(parses("executor", "survey")).toBe(false);
  });
});
