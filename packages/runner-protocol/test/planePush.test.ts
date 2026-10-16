import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_PLANE_PUSH_REFUSALS, PLANE_PUSH_PHASES, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushReportMessage, PlanePushTokenMessage, RUNNER_MESSAGES } from "../src/messages.js";
import { PlanePushReportReply, PlanePushTokenReply, RUNNER_REPLIES } from "../src/replies.js";
import { fieldPaths, g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

/** D#598 P1f-2: the two public-push messages and their replies. */

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const tokenLike = ["g", "hs", "x".repeat(30)].join("_"); // gitleaks:allow

describe("the token request", () => {
  it("is exactly { run_id, lease_generation }, strict, on the constant path", () => {
    expect(PLANE_PUSH_TOKEN_PATH).toBe("/api/runner/plane-push-token");
    expect(RUNNER_MESSAGES.plane_push_token).toBe(PlanePushTokenMessage);
    expect(PlanePushTokenMessage.safeParse({ run_id: RUN, lease_generation: 1 }).success).toBe(true);
    for (const bad of [{}, { run_id: RUN }, { run_id: RUN, lease_generation: 1, repo: "a/b" }, { run_id: RUN, lease_generation: 1, branch: "x" }, { run_id: "x", lease_generation: 1 }]) {
      expect(PlanePushTokenMessage.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the report", () => {
  const base = { run_id: RUN, lease_generation: 2, phase: "pushed", branch: "fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", head_sha: SHA_A, tip_sha: SHA_B };

  it("is strict, on the constant path, and takes the seven phases", () => {
    expect(PLANE_PUSH_REPORT_PATH).toBe("/api/runner/plane-push-report");
    expect(RUNNER_MESSAGES.plane_push_report).toBe(PlanePushReportMessage);
    expect([...PLANE_PUSH_PHASES]).toEqual(["building", "scanning", "pushed", "pr_opened", "refused", "pr_failed", "no_change"]);
    for (const phase of PLANE_PUSH_PHASES) expect(PlanePushReportMessage.safeParse({ ...base, phase }).success, phase).toBe(true);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "merged" }).success).toBe(false);
    expect(nonStrictObjects(PlanePushReportMessage)).toEqual([]);
  });

  it("rejects a content field and a diff field, under any name that could carry file text", () => {
    for (const key of ["content", "diff", "text", "output", "patch", "matched", "value", "message", "body", "token"]) {
      expect(PlanePushReportMessage.safeParse({ ...base, [key]: "anything" }).success, key).toBe(false);
    }
  });

  it("holds at most 100 refusals of exactly { kind, place, rule_key }, and refuses any other field inside one", () => {
    const one = { kind: "identifier", place: "src/a.ts:12", rule_key: "ident.internal-name" };
    expect(MAX_PLANE_PUSH_REFUSALS).toBe(100);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: Array.from({ length: 100 }, () => one) }).success).toBe(true);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: Array.from({ length: 101 }, () => one) }).success).toBe(false);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: [{ ...one, value: "secret" }] }).success).toBe(false);
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "refused", code: "scan_refused", refusals: [{ ...one, place: "a\nb" }] }).success).toBe(false);
  });

  it("bounds the shas, the pull request number and the code", () => {
    for (const bad of [{ head_sha: "xyz" }, { head_sha: "A".repeat(40) }, { tip_sha: "a".repeat(41) }, { pr_number: 0 }, { pr_number: 2 ** 31 }, { code: "Bad Code" }, { branch: "../x" }, { token_revoked: "yes" }]) {
      expect(PlanePushReportMessage.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(PlanePushReportMessage.safeParse({ ...base, phase: "pr_opened", pr_number: 2 ** 31 - 1, token_revoked: false }).success).toBe(true);
  });
});

describe("the replies", () => {
  const good = () => ({ token: tokenLike, expires_at: "2026-10-16T12:00:00.000Z", code_repo: "acme/widgets", branch: "fx/p-0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", base: "main" });

  it("the token reply is strict and exactly { token, expires_at, code_repo, branch, base: main }", () => {
    expect(RUNNER_REPLIES.plane_push_token).toBe(PlanePushTokenReply);
    expect(PlanePushTokenReply.safeParse(good()).success).toBe(true);
    expect(nonStrictObjects(PlanePushTokenReply)).toEqual([]);
    for (const bad of [{ extra: 1 }, { base: "develop" }, { branch: "fx/issue-4" }, { code_repo: "a/b/c" }, { token: "short" }, { token: "has space in it and more padding" }, { expires_at: "soon" }]) {
      expect(PlanePushTokenReply.safeParse({ ...good(), ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the report reply is exactly { recorded: true }", () => {
    expect(RUNNER_REPLIES.plane_push_report).toBe(PlanePushReportReply);
    expect(PlanePushReportReply.safeParse({ recorded: true }).success).toBe(true);
    expect(PlanePushReportReply.safeParse({ recorded: false }).success).toBe(false);
    expect(PlanePushReportReply.safeParse({ recorded: true, state: "pushed" }).success).toBe(false);
  });
});

describe("G1 stays closed in the runner-to-cloud direction", () => {
  it("no runner-to-cloud message has a field named token (only token_revoked, a boolean, is allowed)", () => {
    for (const [name, schema] of Object.entries(RUNNER_MESSAGES)) {
      const names = fieldPaths(schema as z.ZodTypeAny).map((p) => p.slice(p.lastIndexOf(".") + 1));
      expect(names, name).not.toContain("token");
    }
    expect(g1Violations(PlanePushReportMessage)).toEqual([]);
    expect(PlanePushReportMessage.shape.token_revoked.safeParse(["g", "hs", "abcdefghijklmnopqrstuvwxyz0123"].join("_")).success).toBe(false);
  });

  it("only the token reply carries a field named token", () => {
    const holders = Object.entries(RUNNER_REPLIES).filter(([, schema]) => fieldPaths(schema as z.ZodTypeAny).some((p) => p.split(".").pop() === "token"));
    expect(holders.map(([name]) => name)).toEqual(["plane_push_token"]);
  });
});
