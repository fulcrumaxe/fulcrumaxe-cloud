import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_PLANE_MERGE_PATHS,
  PLANE_MERGE_ABORT_CODES,
  PLANE_MERGE_CLAIM_PATH,
  PLANE_MERGE_REPORT_PATH,
  PLANE_MERGE_VERIFY_PATH,
  PlaneMergeClaimMessage,
  PlaneMergeReportMessage,
  PlaneMergeVerifyMessage,
  RUNNER_MESSAGES,
} from "../src/messages.js";
import { ClaimIdleReply, PlaneMergeClaimReply, PlaneMergeReportReply, PlaneMergeRetryReply, PlaneMergeVerifyReply, RUNNER_REPLIES } from "../src/replies.js";
import { HelloMessage } from "../src/messages.js";
import { PLANE_MERGE_CAPABILITY, RUNNER_CAPABILITIES } from "../src/job.js";
import { fieldPaths, g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

const ORDER = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const A = "a".repeat(40);
const B = "b".repeat(40);
const DIGEST = "c".repeat(64);
const verify = (over: Record<string, unknown> = {}) => ({ order_id: ORDER, lease_generation: 1, reviewed_head: A, public_head: B, same: true, incomplete: false, paths: ["src/a.ts"], pairing_digest: DIGEST, token_revoked: true, ...over });
const report = (over: Record<string, unknown> = {}) => ({ order_id: ORDER, lease_generation: 1, result: "merged", token_revoked: true, ...over });
const CRED = ["g", "hs", "x".repeat(30)].join("_"); // gitleaks:allow
const claimed = (over: Record<string, unknown> = {}) => ({
  order_id: ORDER,
  lease_generation: 1,
  code_repo: "acme/widgets-public",
  pr_number: 9,
  public_branch: `fx/p-${ORDER}`,
  expected_public_head: B,
  reviewed_head: A,
  private_repo: { id: ORDER, owner: "acme", name: "widgets" },
  overlay_globs: ["docs/ops/"],
  pairing_digest: DIGEST,
  read: { token: CRED, expires_at: "2026-10-25T12:00:00.000Z" },
  ...over,
});

describe("the plane_merge_v1 capability", () => {
  it("is a hello capability, once, and gates no role", () => {
    expect(PLANE_MERGE_CAPABILITY).toBe("plane_merge_v1");
    expect(RUNNER_CAPABILITIES).toContain(PLANE_MERGE_CAPABILITY);
    const hello = { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "container" };
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["wake_v1", "plane_merge_v1"] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["plane_merge_v1", "plane_merge_v1"] }).success).toBe(false);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["plane_merge_v2"] }).success).toBe(false);
  });
});

describe("the three requests", () => {
  it("are on the constant paths and in the message table", () => {
    expect([PLANE_MERGE_CLAIM_PATH, PLANE_MERGE_VERIFY_PATH, PLANE_MERGE_REPORT_PATH]).toEqual(["/api/runner/plane-merge-claim", "/api/runner/plane-merge-verify", "/api/runner/plane-merge-report"]);
    expect(RUNNER_MESSAGES.plane_merge_claim).toBe(PlaneMergeClaimMessage);
    expect(RUNNER_MESSAGES.plane_merge_verify).toBe(PlaneMergeVerifyMessage);
    expect(RUNNER_MESSAGES.plane_merge_report).toBe(PlaneMergeReportMessage);
  });
  it("a claim carries nothing", () => {
    expect(PlaneMergeClaimMessage.safeParse({}).success).toBe(true);
    for (const extra of [{ repo: "a/b" }, { order_id: ORDER }, { sha: A }]) expect(PlaneMergeClaimMessage.safeParse(extra).success).toBe(false);
  });
  it("a verify is strict, binds both shas and the digest, and never says same with incomplete", () => {
    expect(PlaneMergeVerifyMessage.safeParse(verify()).success).toBe(true);
    expect(PlaneMergeVerifyMessage.safeParse(verify({ same: false, incomplete: true, paths: [] })).success).toBe(true);
    expect(PlaneMergeVerifyMessage.safeParse(verify({ same: false, incomplete: false })).success).toBe(true);
    const refuse = (over: Record<string, unknown>, label: string) => expect(PlaneMergeVerifyMessage.safeParse(verify(over)).success, label).toBe(false);
    refuse({ same: true, incomplete: true }, "same and incomplete");
    refuse({ extra: 1 }, "unknown field");
    refuse({ repo: "a/b" }, "a repo name");
    refuse({ patch: "@@" }, "a patch");
    refuse({ reviewed_head: "abc" }, "short sha");
    refuse({ public_head: A.toUpperCase() }, "uppercase sha");
    refuse({ pairing_digest: "x" }, "digest");
    refuse({ lease_generation: 0 }, "generation 0");
    refuse({ order_id: "nope" }, "order id");
    refuse({ token_revoked: undefined }, "revocation unsaid");
    refuse({ paths: ["a\nb"] }, "control character in a path");
    refuse({ paths: [""] }, "empty path");
    refuse({ paths: Array.from({ length: MAX_PLANE_MERGE_PATHS + 1 }, (_, i) => `f${i}`) }, "too many paths");
    expect(PlaneMergeVerifyMessage.safeParse(verify({ paths: Array.from({ length: MAX_PLANE_MERGE_PATHS }, (_, i) => `f${i}`) })).success).toBe(true);
  });
  it("a report says merged, refused or aborted, and an abort always names its closed code", () => {
    expect(PlaneMergeReportMessage.safeParse(report()).success).toBe(true);
    expect(PlaneMergeReportMessage.safeParse(report({ result: "refused", http_status: 409 })).success).toBe(true);
    for (const code of PLANE_MERGE_ABORT_CODES) expect(PlaneMergeReportMessage.safeParse(report({ result: "aborted", abort_code: code })).success, code).toBe(true);
    const refuse = (over: Record<string, unknown>, label: string) => expect(PlaneMergeReportMessage.safeParse(report(over)).success, label).toBe(false);
    refuse({ result: "aborted" }, "abort without a code");
    refuse({ abort_code: "head_moved" }, "code without abort");
    refuse({ result: "aborted", abort_code: "because" }, "free-text code");
    refuse({ result: "done" }, "unknown result");
    refuse({ http_status: 99 }, "status");
    refuse({ http_status: 600 }, "status");
    refuse({ sha: A }, "a sha");
    refuse({ message: "text" }, "message text");
  });
  it("no request has a field that could carry a token, content, a diff or a patch", () => {
    for (const schema of [PlaneMergeClaimMessage, PlaneMergeVerifyMessage, PlaneMergeReportMessage]) {
      expect(nonStrictObjects(schema)).toEqual([]);
      expect(g1Violations(schema)).toEqual([]);
      const names = fieldPaths(schema);
      expect(names.filter((n) => /^token$|content|diff|patch|body|text|secret/i.test(n))).toEqual([]);
    }
    expect(PlaneMergeVerifyMessage.safeParse(verify({ token_revoked: CRED })).success).toBe(false);
    expect(PlaneMergeReportMessage.safeParse(report({ token_revoked: CRED })).success).toBe(false);
  });
});

describe("the replies", () => {
  it("are in the reply table, strict at every depth and clear of G1 apart from the two credentials", () => {
    expect(RUNNER_REPLIES.plane_merge_claim).toBe(PlaneMergeClaimReply);
    expect(RUNNER_REPLIES.plane_merge_verify).toBe(PlaneMergeVerifyReply);
    expect(RUNNER_REPLIES.plane_merge_report).toBe(PlaneMergeReportReply);
    expect(RUNNER_REPLIES.plane_merge_retry).toBe(PlaneMergeRetryReply);
    for (const schema of [PlaneMergeClaimReply, PlaneMergeVerifyReply]) {
      for (const member of (schema as unknown as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options) {
        expect(nonStrictObjects(member)).toEqual([]);
        expect(g1Violations(member)).toEqual([]);
      }
    }
  });
  it("a claim reply carries the bound facts and the read credential; an idle one only retry_after", () => {
    expect(PlaneMergeClaimReply.safeParse(claimed()).success).toBe(true);
    expect(PlaneMergeClaimReply.safeParse({ retry_after: 60 }).success).toBe(true);
    const refuse = (over: Record<string, unknown>, label: string) => expect(PlaneMergeClaimReply.safeParse(claimed(over)).success, label).toBe(false);
    refuse({ extra: 1 }, "unknown");
    refuse({ code_repo: "nope" }, "repo");
    refuse({ public_branch: "main" }, "branch");
    refuse({ expected_public_head: "abc" }, "sha");
    refuse({ read: { token: "short", expires_at: "2026-10-25T12:00:00.000Z" } }, "short credential");
    refuse({ read: { token: CRED, expires_at: "soon" } }, "expiry");
    refuse({ read: { token: CRED, expires_at: "2026-10-25T12:00:00.000Z", scope: "write" } }, "scope field");
    refuse({ overlay_globs: [] }, "no globs");
    refuse({ private_repo: { id: ORDER, owner: "acme", name: "w", extra: 1 } }, "private repo extra");
    expect(PlaneMergeClaimReply.safeParse({ retry_after: 60, order_id: ORDER }).success).toBe(false);
  });
  it("a verify reply is exactly one of go, no go with reasons, or head moved", () => {
    const exp = "2026-10-25T12:00:00.000Z";
    expect(PlaneMergeVerifyReply.safeParse({ go: true, token: CRED, expires_at: exp, sha: B }).success).toBe(true);
    expect(PlaneMergeVerifyReply.safeParse({ go: false, reasons: ["public_head_not_reviewed", "ci_not_green"] }).success).toBe(true);
    expect(PlaneMergeVerifyReply.safeParse({ go: false, head_moved: true }).success).toBe(true);
    for (const bad of [{ go: true, token: CRED, expires_at: exp }, { go: true, sha: B }, { go: false }, { go: false, reasons: [] }, { go: false, reasons: ["Not Snake"] }, { go: false, head_moved: false }, { go: true, reasons: ["x"], token: CRED, expires_at: exp, sha: B }, { go: false, reasons: ["a"], token: CRED }]) {
      expect(PlaneMergeVerifyReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the report reply and the retry reply are tiny and strict", () => {
    expect(PlaneMergeReportReply.safeParse({ recorded: true }).success).toBe(true);
    expect(PlaneMergeReportReply.safeParse({ recorded: true, state: "merged" }).success).toBe(false);
    expect(PlaneMergeRetryReply.safeParse({ retry_after: 15 }).success).toBe(true);
    expect(PlaneMergeRetryReply.safeParse({ retry_after: 0 }).success).toBe(false);
  });
  it("the claim and idle replies take the optional merge_order flag, only as true", () => {
    expect(ClaimIdleReply.safeParse({ retry_after: 60, merge_order: true }).success).toBe(true);
    expect(ClaimIdleReply.safeParse({ retry_after: 60 }).success).toBe(true);
    expect(ClaimIdleReply.safeParse({ retry_after: 60, merge_order: false }).success).toBe(false);
  });
});
