import { describe, expect, it } from "vitest";
import { REPO_TOKEN_PATH, REPO_TOKEN_STOP_PATH, RepoTokenMessage, RepoTokenReply, RepoTokenStopMessage, RepoTokenStopReply, SetupPushTokenReply } from "../src/machineJobs.js";
import { REPO_TOKEN_REFRESH_CAPABILITY, RUNNER_CAPABILITIES } from "../src/job.js";

const ID = "11111111-1111-4111-8111-111111111111";

/** D#845 ON-18: the repo-token route's strict message and reply. */
describe("the repo token messages", () => {
  it("the path is the engine route, and the capability that gates it is a known one", () => {
    expect(REPO_TOKEN_PATH).toBe("/api/runner/engine/repo-token");
    expect(RUNNER_CAPABILITIES).toContain(REPO_TOKEN_REFRESH_CAPABILITY);
  });
  it("the message is exactly a repository id and a session id: an extra key, a missing key, a bad id or a bad uuid is refused", () => {
    expect(RepoTokenMessage.safeParse({ repo_gh_id: 12, session_id: ID }).success).toBe(true);
    for (const bad of [{ repo_gh_id: 12 }, { session_id: ID }, { repo_gh_id: 12, session_id: ID, owner: "x" }, { repo_gh_id: 0, session_id: ID }, { repo_gh_id: -1, session_id: ID }, { repo_gh_id: 1.5, session_id: ID }, { repo_gh_id: 2 ** 60, session_id: ID }, { repo_gh_id: "12", session_id: ID }, { repo_gh_id: 12, session_id: "abc" }, { repo_gh_id: 12, session_id: null }, {}]) {
      expect(RepoTokenMessage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the reply is a token and an expiry, nothing else, and is the setup push's shape", () => {
    expect(RepoTokenReply).toBe(SetupPushTokenReply);
    expect(RepoTokenReply.safeParse({ token: "ghs_x", expires_at: "2026-11-27T20:00:00.000Z" }).success).toBe(true);
    for (const bad of [{ token: "", expires_at: "2026-11-27T20:00:00.000Z" }, { token: "t".repeat(513), expires_at: "2026-11-27T20:00:00.000Z" }, { token: "t", expires_at: "tomorrow" }, { token: "t", expires_at: "2026-11-27T20:00:00.000Z", permissions: {} }, { token: "t" }]) {
      expect(RepoTokenReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the repo token stop report messages", () => {
  it("is its own path, takes the token route's strict message, and answers recorded or already, nothing else", () => {
    expect(REPO_TOKEN_STOP_PATH).toBe("/api/runner/engine/repo-token-stop");
    expect(REPO_TOKEN_STOP_PATH).not.toBe(REPO_TOKEN_PATH);
    expect(RepoTokenStopMessage).toBe(RepoTokenMessage);
    for (const result of ["recorded", "already"]) expect(RepoTokenStopReply.safeParse({ result }).success).toBe(true);
    for (const bad of [{ result: "done" }, { result: "recorded", extra: 1 }, {}, { result: null }, "recorded"]) expect(RepoTokenStopReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
