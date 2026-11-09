import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BROWSER_CHROME_CAPABILITY,
  BROWSER_JOB_ROLES,
  BROWSER_JOB_SLOTS_PER_RUNNER,
  DEPLOY_ORDER_CAPABILITY,
  DEPLOY_ORDER_CLAIM_PATH,
  DEPLOY_ORDER_FAILURE_CODES,
  DEPLOY_ORDER_LEASE_SECONDS,
  DEPLOY_ORDER_MAX_ATTEMPTS,
  DEPLOY_ORDER_REPORT_PATH,
  DEPLOY_VERIFIER_ROLE,
  DEPLOY_VERIFIER_RUNNER_TOOLS,
  DeployOrderClaimMessage,
  DeployOrderClaimReply,
  DeployOrderReportMessage,
  DeployOrderReportReply,
  MAX_DEPLOY_OUTPUT_LINE_CHARS,
  MAX_DEPLOY_OUTPUT_TAIL_LINES,
  isBrowserJobRole,
} from "../src/index.js";
import { HelloMessage, RUNNER_MESSAGES } from "../src/messages.js";
import { ClaimIdleReply, ClaimedReply, RUNNER_REPLIES } from "../src/replies.js";
import { JOB_CLASS_BY_ROLE, JobSchema, LIGHT_JOB_ROLES, PINNED_COMMIT_JOB_ROLES, RUNNER_CAPABILITIES, RUNNER_CAPABILITY_FOR_ROLE, RUNNER_ELIGIBLE_ROLES, jobCarriesPinnedCommit, jobClassOfRole } from "../src/job.js";
import { sampleJob } from "./helpers/sampleJob.js";
import { fieldPaths, g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

const ORDER = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const SHA = "a".repeat(40);
const report = (over: Record<string, unknown> = {}) => ({ order_id: ORDER, lease_generation: 1, result: "succeeded", exit_code: 0, ...over });
const failed = (over: Record<string, unknown> = {}) => ({ order_id: ORDER, lease_generation: 1, result: "failed", failure_code: "timeout", ...over });
const claimed = (over: Record<string, unknown> = {}) => ({ order_id: ORDER, lease_generation: 1, lease_expires_at: "2026-11-09T10:20:00.000Z", repo: { owner: "acme", name: "widgets" }, sha: SHA, ...over });

describe("the deploy verifier role and its capabilities (D#749 V2a)", () => {
  it("is a runner-eligible role gated by browser_chrome_v1 alone", () => {
    expect(DEPLOY_VERIFIER_ROLE).toBe("deploy-verifier");
    expect(RUNNER_ELIGIBLE_ROLES).toContain(DEPLOY_VERIFIER_ROLE);
    expect(BROWSER_CHROME_CAPABILITY).toBe("browser_chrome_v1");
    expect(RUNNER_CAPABILITY_FOR_ROLE[DEPLOY_VERIFIER_ROLE]).toBe(BROWSER_CHROME_CAPABILITY);
    expect(RUNNER_CAPABILITIES).toContain(BROWSER_CHROME_CAPABILITY);
    expect(Object.values(RUNNER_CAPABILITY_FOR_ROLE)).not.toContain(DEPLOY_ORDER_CAPABILITY);
  });

  it("deploy_order_v1 gates no role, is a hello capability once, and an old hello without it still parses", () => {
    expect(DEPLOY_ORDER_CAPABILITY).toBe("deploy_order_v1");
    expect(RUNNER_CAPABILITIES).toContain(DEPLOY_ORDER_CAPABILITY);
    const hello = { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "container" };
    expect(HelloMessage.safeParse(hello).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["browser_chrome_v1", "deploy_order_v1"] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["deploy_order_v1", "deploy_order_v1"] }).success).toBe(false);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["deploy_order_v2"] }).success).toBe(false);
  });

  it("counts as heavy and not light, is the one browser role, and a runner holds one at a time", () => {
    expect(jobClassOfRole(DEPLOY_VERIFIER_ROLE)).toBe("heavy");
    expect(JOB_CLASS_BY_ROLE[DEPLOY_VERIFIER_ROLE]).toBe("heavy");
    expect(LIGHT_JOB_ROLES).not.toContain(DEPLOY_VERIFIER_ROLE);
    expect([...BROWSER_JOB_ROLES]).toEqual([DEPLOY_VERIFIER_ROLE]);
    expect(isBrowserJobRole(DEPLOY_VERIFIER_ROLE)).toBe(true);
    for (const role of ["executor", "code-reviewer", "proposal-verifier", "", "constructor"]) expect(isBrowserJobRole(role), role).toBe(false);
    expect(BROWSER_JOB_SLOTS_PER_RUNNER).toBe(1);
  });

  it("its job carries the pinned merge commit like the other pinned roles, and its tools are the bare read tools", () => {
    expect(PINNED_COMMIT_JOB_ROLES).toContain(DEPLOY_VERIFIER_ROLE);
    expect(jobCarriesPinnedCommit(DEPLOY_VERIFIER_ROLE)).toBe(true);
    expect(JobSchema.safeParse(sampleJob({ role: DEPLOY_VERIFIER_ROLE, review: { head_sha: SHA } })).success).toBe(true);
    expect(JobSchema.safeParse(sampleJob({ role: DEPLOY_VERIFIER_ROLE, review: { head_sha: "A".repeat(40) } })).success).toBe(false);
    expect([...DEPLOY_VERIFIER_RUNNER_TOOLS]).toEqual(["Read", "Glob", "Grep"]);
    expect(Object.isFrozen(DEPLOY_VERIFIER_RUNNER_TOOLS)).toBe(true);
  });
});

describe("the deploy order messages", () => {
  it("are in the message table, on their own paths", () => {
    expect(RUNNER_MESSAGES.deploy_order_claim).toBe(DeployOrderClaimMessage);
    expect(RUNNER_MESSAGES.deploy_order_report).toBe(DeployOrderReportMessage);
    expect([DEPLOY_ORDER_CLAIM_PATH, DEPLOY_ORDER_REPORT_PATH]).toEqual(["/api/runner/deploy-order-claim", "/api/runner/deploy-order-report"]);
    expect(DEPLOY_ORDER_MAX_ATTEMPTS).toBe(3);
    expect(DEPLOY_ORDER_LEASE_SECONDS).toBeGreaterThan(0);
  });

  it("a claim carries nothing", () => {
    expect(DeployOrderClaimMessage.safeParse({}).success).toBe(true);
    for (const extra of [{ order_id: ORDER }, { repo: "acme/widgets" }, { sha: SHA }, { command: "deploy" }]) expect(DeployOrderClaimMessage.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
  });

  it("a report: a success is exit status 0 with no failure code, and each closed failure code parses", () => {
    expect(DeployOrderReportMessage.safeParse(report()).success).toBe(true);
    expect(DeployOrderReportMessage.safeParse(report({ output_tail: ["built", "deployed"] })).success).toBe(true);
    for (const failure_code of DEPLOY_ORDER_FAILURE_CODES) {
      const m = failure_code === "exit_nonzero" ? failed({ failure_code, exit_code: 2 }) : failed({ failure_code });
      expect(DeployOrderReportMessage.safeParse(m).success, failure_code).toBe(true);
    }
    const no = (m: unknown, label: string) => expect(DeployOrderReportMessage.safeParse(m).success, label).toBe(false);
    no(report({ exit_code: undefined }), "a success with no status");
    no(report({ exit_code: 1 }), "a success with a non-zero status");
    no(report({ failure_code: "timeout" }), "a success that names a failure");
    no(failed({ failure_code: undefined }), "a failure with no code");
    no(failed({ failure_code: "on_fire" }), "an unknown code");
    no(failed({ failure_code: "exit_nonzero" }), "exit_nonzero with no status");
    no(failed({ failure_code: "exit_nonzero", exit_code: 0 }), "exit_nonzero with status 0");
    no(failed({ failure_code: "timeout", exit_code: 1 }), "a status with a timeout");
    no(failed({ failure_code: "exit_nonzero", exit_code: 256 }), "a status over 255");
    no(report({ result: "merged" }), "an unknown result");
    no(report({ lease_generation: 0 }), "generation 0");
    no(report({ order_id: "x" }), "a bad order id");
  });

  it("is strict: no repository, sha, command, path, url or credential can ride on a report", () => {
    for (const extra of [{ repo: "acme/widgets" }, { sha: SHA }, { command: "bash deploy.sh" }, { argv: ["x"] }, { path: "/tmp/x" }, { url: "https://example.test" }, { token: "x".repeat(30) }]) {
      expect(DeployOrderReportMessage.safeParse(report(extra)).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("bounds the output: at most 20 lines of 200 characters, no control or format character, no lone surrogate", () => {
    const ok = (lines: unknown[], label: string) => expect(DeployOrderReportMessage.safeParse(report({ output_tail: lines })).success, label).toBe(true);
    const no = (lines: unknown[], label: string) => expect(DeployOrderReportMessage.safeParse(report({ output_tail: lines })).success, label).toBe(false);
    expect([MAX_DEPLOY_OUTPUT_TAIL_LINES, MAX_DEPLOY_OUTPUT_LINE_CHARS]).toEqual([20, 200]);
    ok(Array.from({ length: 20 }, () => "x".repeat(200)), "the largest");
    ok([""], "an empty line");
    ok(["déploiement réussi ✓"], "text");
    no(Array.from({ length: 21 }, () => "x"), "21 lines");
    no(["x".repeat(201)], "a long line");
    no(["a\nb"], "a newline inside a line");
    no(["a\u0000b"], "a NUL");
    no(["a\u001b[31mred"], "an escape");
    no(["a‮b"], "a bidirectional override");
    no(["a b"], "a line separator");
    no(["a\ud800b"], "a lone surrogate");
    no([5], "a number");
  });

  it("the schema walk finds every object strict and no credential-looking field", () => {
    for (const schema of [DeployOrderClaimMessage, DeployOrderReportMessage]) {
      expect(nonStrictObjects(schema)).toEqual([]);
      expect(g1Violations(schema)).toEqual([]);
    }
    expect(fieldPaths(DeployOrderReportMessage).sort()).toEqual(["exit_code", "failure_code", "lease_generation", "order_id", "output_tail", "result"]);
  });
});

describe("the deploy order replies", () => {
  it("are in the reply table, strict at every depth and clear of G1", () => {
    expect(RUNNER_REPLIES.deploy_order_claim).toBe(DeployOrderClaimReply);
    expect(RUNNER_REPLIES.deploy_order_report).toBe(DeployOrderReportReply);
    for (const member of (DeployOrderClaimReply as unknown as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options) {
      expect(nonStrictObjects(member)).toEqual([]);
      expect(g1Violations(member)).toEqual([]);
    }
    expect(nonStrictObjects(DeployOrderReportReply)).toEqual([]);
  });

  it("a claimed reply names the repository and the commit, and no field can hold a command, a URL, a path or a credential", () => {
    expect(DeployOrderClaimReply.safeParse(claimed()).success).toBe(true);
    expect(DeployOrderClaimReply.safeParse(claimed({ sha: "b".repeat(64) })).success).toBe(true);
    expect(DeployOrderClaimReply.safeParse({ retry_after: 60 }).success).toBe(true);
    const fields = fieldPaths((DeployOrderClaimReply as unknown as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options[0]).sort();
    expect(fields).toEqual(["lease_expires_at", "lease_generation", "order_id", "repo", "repo.name", "repo.owner", "sha"]);
    const no = (m: unknown, label: string) => expect(DeployOrderClaimReply.safeParse(m).success, label).toBe(false);
    for (const extra of [{ command: "bash deploy.sh" }, { argv: ["deploy"] }, { script: "deploy.sh" }, { base_url: "https://staging.example.test" }, { token: "x".repeat(30) }, { env: { A: "1" } }]) no(claimed(extra), JSON.stringify(extra));
    no(claimed({ sha: "main" }), "a branch name for a sha");
    no(claimed({ sha: "A".repeat(40) }), "an upper-case sha");
    no(claimed({ repo: { owner: "acme/evil", name: "widgets" } }), "a path in the owner");
    no(claimed({ repo: { owner: "acme", name: "widgets; rm -rf /" } }), "a command in the name");
    no(claimed({ repo: { owner: "acme", name: "widgets", url: "https://example.test" } }), "an extra repo key");
    no(claimed({ lease_generation: 0 }), "generation 0");
    no({ retry_after: 0 }, "a zero retry");
  });

  it("the deploy_order hint is only ever true, on an idle and on a claimed reply, and its absence still parses", () => {
    expect(ClaimIdleReply.safeParse({ retry_after: 60 }).success).toBe(true);
    expect(ClaimIdleReply.safeParse({ retry_after: 60, deploy_order: true }).success).toBe(true);
    expect(ClaimIdleReply.safeParse({ retry_after: 60, deploy_order: false }).success).toBe(false);
    expect(ClaimIdleReply.safeParse({ retry_after: 60, deploy_order: "yes" }).success).toBe(false);
    expect(ClaimedReply.innerType().shape.deploy_order).toBeDefined();
  });

  it("an older runner's strict parse refuses the new key, which is why the cloud sends it only to a capable runner", () => {
    const old = ClaimIdleReply.omit({ deploy_order: true }).strict();
    expect(old.safeParse({ retry_after: 60 }).success).toBe(true);
    expect(old.safeParse({ retry_after: 60, deploy_order: true }).success).toBe(false);
  });
});
