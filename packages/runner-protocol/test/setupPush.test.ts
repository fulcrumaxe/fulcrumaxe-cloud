import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMPTY_BASE_COMMIT, EMPTY_BASE_COMMIT_TEXT, SetupProgressBody, SetupPushTokenMessage, SetupPushTokenReply, setupPushTokenPath } from "../src/machineJobs.js";

const ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const HEAD = "c".repeat(40);

describe("D#845 ON-8f1 protocol", () => {
  it("EMPTY_BASE_COMMIT is the git id of its own text: an empty tree, one fixed identity, the epoch", () => {
    const body = Buffer.from(EMPTY_BASE_COMMIT_TEXT, "utf8");
    expect(createHash("sha1").update(`commit ${body.length}\0`).update(body).digest("hex")).toBe(EMPTY_BASE_COMMIT);
    expect(EMPTY_BASE_COMMIT_TEXT).toContain("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n");
    expect(EMPTY_BASE_COMMIT_TEXT).toContain("author fulcrumaxe <runner@localhost> 0 +0000\ncommitter fulcrumaxe <runner@localhost> 0 +0000\n");
  });

  it("head_sha is a full commit id on the push step's ok report and nowhere else", () => {
    const body = { job_id: ID, seq: 3 };
    expect(SetupProgressBody.safeParse({ ...body, sub_step: "push", state: "ok", head_sha: HEAD }).success).toBe(true);
    expect(SetupProgressBody.safeParse({ ...body, sub_step: "push", state: "ok" }).success).toBe(true); // the cloud's route requires it; the schema stays additive for older runners
    for (const bad of [
      { sub_step: "push", state: "started", head_sha: HEAD },
      { sub_step: "push", state: "failed", failure_code: "push_failed", head_sha: HEAD },
      { sub_step: "pr_open", state: "ok", head_sha: HEAD },
      { sub_step: "bundle_out", state: "ok", head_sha: HEAD },
      { sub_step: "push", state: "ok", head_sha: "C".repeat(40) },
      { sub_step: "push", state: "ok", head_sha: "c".repeat(39) },
      { sub_step: "push", state: "ok", head_sha: `${HEAD}0` },
    ]) expect(SetupProgressBody.safeParse({ ...body, ...bad }).success).toBe(false);
  });

  it("the push-token message names the job and nothing else, and the reply is one token and its expiry", () => {
    expect(setupPushTokenPath(ID)).toBe(`/api/runner/setup/${ID}/push-token`);
    expect(SetupPushTokenMessage.safeParse({ job_id: ID }).success).toBe(true);
    for (const bad of [{}, { job_id: "x" }, { job_id: ID, repo: "o/n" }, { job_id: ID, branch: "main" }]) expect(SetupPushTokenMessage.safeParse(bad).success).toBe(false);
    expect(SetupPushTokenReply.safeParse({ token: "ghs_x", expires_at: "2026-11-23T10:00:00.000Z" }).success).toBe(true);
    for (const bad of [{ token: "", expires_at: "2026-11-23T10:00:00.000Z" }, { token: "t" }, { token: "t", expires_at: "tomorrow" }, { token: "t", expires_at: "2026-11-23T10:00:00.000Z", repo: "o/n" }]) expect(SetupPushTokenReply.safeParse(bad).success).toBe(false);
  });
});
