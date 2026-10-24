import { describe, expect, it } from "vitest";
import {
  CURRENT_PROTOCOL_VERSION,
  HelloMessage,
  JobSchema,
  LIGHT_JOB_ROLES,
  PINNED_COMMIT_JOB_ROLES,
  PROPOSAL_VERIFIER_ROLE,
  PROPOSAL_VERIFIER_RUNNER_TOOLS,
  REVIEW_JOB_ROLES,
  RUNNER_CAPABILITIES,
  RUNNER_CAPABILITY_FOR_ROLE,
  VERIFIER_READ_GUARD_SCRIPT,
  isGuardableCheckout,
  isReviewJobRole,
  jobCarriesPinnedCommit,
  verifierGuardCommand,
  verifierReadGuardHook,
} from "../src/index.js";
import { sampleJob } from "./helpers/sampleJob.js";
import { readFileSync } from "node:fs";

const hello = JSON.parse(readFileSync(new URL("./fixtures/hello-legacy.json", import.meta.url), "utf8")) as Record<string, unknown>;

const SHA = "a".repeat(40);

/** D#483 S4-b2c: the claim verifier as a runner job, on the protocol side. */
describe("the claim verifier role on the wire", () => {
  it("is runner eligible and light, without moving the protocol version (still 8)", () => {
    expect(CURRENT_PROTOCOL_VERSION).toBe(8);
    expect(LIGHT_JOB_ROLES).toContain(PROPOSAL_VERIFIER_ROLE);
    expect(JobSchema.safeParse(sampleJob({ role: PROPOSAL_VERIFIER_ROLE, review: { head_sha: SHA } })).success).toBe(true);
  });

  it("is not a review role (no merge gate, no review prompt, no sandbox route) but its job carries the pinned commit", () => {
    expect(isReviewJobRole(PROPOSAL_VERIFIER_ROLE)).toBe(false);
    expect((REVIEW_JOB_ROLES as readonly string[]).includes(PROPOSAL_VERIFIER_ROLE)).toBe(false);
    expect([...PINNED_COMMIT_JOB_ROLES]).toEqual([...REVIEW_JOB_ROLES, PROPOSAL_VERIFIER_ROLE]);
    expect(jobCarriesPinnedCommit(PROPOSAL_VERIFIER_ROLE)).toBe(true);
    for (const role of ["executor", "docs-writer", "project-manager", "", "constructor"]) expect(jobCarriesPinnedCommit(role), role).toBe(false);
  });

  it("a runner built before it refuses the job at parse: the role is a closed enum, so an old schema without it fails", () => {
    const oldRoles = new Set(["executor", "project-manager", "technical-architect", "product-owner", "cost-analyst", "performance-expert", "security-expert", "docs-writer", "accessibility-reviewer", "code-reviewer", "security-reviewer", "acceptance-tester", "debater"]);
    expect(oldRoles.has(PROPOSAL_VERIFIER_ROLE)).toBe(false);
    // The schema is strict: a role string outside the list does not parse, which is what a protocol-8 runner's own copy does with this role.
    expect(JobSchema.safeParse(sampleJob({ role: "proposal-verifier-x", review: { head_sha: SHA } })).success).toBe(false);
  });

  it("is gated by the proposal_verifier capability, and no other role is", () => {
    // D#6 RUNNER-WAKE R3a: wake_v1 is a capability too, but it gates no role (below).
    expect([...RUNNER_CAPABILITIES]).toEqual(["proposal_verifier", "wake_v1"]);
    expect(RUNNER_CAPABILITY_FOR_ROLE).toEqual({ [PROPOSAL_VERIFIER_ROLE]: "proposal_verifier" });
  });

  it("the runner tool list is the bare Read, Glob and Grep: no Bash, no LS, no edit, no network", () => {
    expect([...PROPOSAL_VERIFIER_RUNNER_TOOLS]).toEqual(["Read", "Glob", "Grep"]);
    expect(Object.isFrozen(PROPOSAL_VERIFIER_RUNNER_TOOLS)).toBe(true);
  });
});

describe("hello capabilities", () => {
  const parse = (capabilities: unknown) => HelloMessage.safeParse({ ...hello, capabilities }).success;

  it("are optional: a hello without them still parses, so a runner built before them is unchanged", () => {
    expect(HelloMessage.safeParse(hello).success).toBe(true);
    expect(parse([])).toBe(true);
    expect(parse(["proposal_verifier"])).toBe(true);
  });

  it("refuse an unknown code, a repeat, a non-list and anything that is not a string", () => {
    for (const bad of [["proposal_verifier", "proposal_verifier"], ["shell"], ["Proposal_Verifier"], "proposal_verifier", [1], [null], {}]) expect(parse(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("the shared read guard", () => {
  it("builds the sandbox's exact command for its checkout", () => {
    expect(verifierGuardCommand("/vercel/sandbox/repo")).toBe(`/bin/sh -c '${VERIFIER_READ_GUARD_SCRIPT}' fx-read-guard /vercel/sandbox/repo`);
    expect(verifierReadGuardHook("/w").matcher).toBe("Read|Glob|Grep");
    expect(verifierReadGuardHook("/w").hooks).toHaveLength(1);
  });

  it("refuses a checkout the command could not carry unquoted (fail closed: no settings, no run)", () => {
    for (const dir of ["", "relative/dir", "/a b", "/a;rm -rf", "/a'b", "/a$(x)", "/a/../b", "/a/./b", "/a/", "/a\nb", "/a`b`", "/a*", "/-x"]) {
      expect(isGuardableCheckout(dir), JSON.stringify(dir)).toBe(false);
      expect(() => verifierGuardCommand(dir), JSON.stringify(dir)).toThrow();
    }
    for (const dir of ["/home/u/.local/state/fx-runner/workspaces/0b6c1a8e-0d6e-4c4b-9d2a-2b7f9e4e1c11", "/vercel/sandbox/repo", "/w"]) expect(isGuardableCheckout(dir), dir).toBe(true);
  });
});
