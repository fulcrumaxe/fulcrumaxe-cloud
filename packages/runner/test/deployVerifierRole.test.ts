import { describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_ROLE, DEPLOY_VERIFIER_RUNNER_TOOLS, RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
import { CONFINED_READ_ROLES, PLATFORM_ROLES, RUNNER_ONLY_ROLES, TOOL_LISTED_ROLES, UnknownRoleError, agentSettingsFor, runnerToolsForRole, toolsForRole } from "../src/agentConfig.js";

/**
 * D#749 V2a: the deploy verifier is a runner job and nothing else. The cloud's sandbox has no tool list for it (a hosted run of it is refused like any unknown
 * role), and the list a runner job is signed with is the three read tools: no Bash, no edit tool, no write tool, no network.
 */
describe("the deploy verifier role in the runner package", () => {
  it("is a runner-eligible role and a runner-only role", () => {
    expect(RUNNER_ELIGIBLE_ROLES).toContain(DEPLOY_VERIFIER_ROLE);
    expect([...RUNNER_ONLY_ROLES]).toEqual([DEPLOY_VERIFIER_ROLE]);
  });

  it("has no sandbox tool list: toolsForRole refuses it, and it is neither a platform role nor a confined read role", () => {
    expect(() => toolsForRole(DEPLOY_VERIFIER_ROLE)).toThrow(UnknownRoleError);
    expect(() => agentSettingsFor(DEPLOY_VERIFIER_ROLE)).toThrow(UnknownRoleError);
    expect(TOOL_LISTED_ROLES).not.toContain(DEPLOY_VERIFIER_ROLE);
    expect(PLATFORM_ROLES).not.toContain(DEPLOY_VERIFIER_ROLE);
    expect(CONFINED_READ_ROLES.has(DEPLOY_VERIFIER_ROLE)).toBe(false);
  });

  it("is signed with Read, Glob and Grep only: nothing that writes, runs a command or reaches the network", () => {
    expect([...runnerToolsForRole(DEPLOY_VERIFIER_ROLE)]).toEqual(["Read", "Glob", "Grep"]);
    expect(runnerToolsForRole(DEPLOY_VERIFIER_ROLE)).toBe(DEPLOY_VERIFIER_RUNNER_TOOLS);
    expect(Object.isFrozen(DEPLOY_VERIFIER_RUNNER_TOOLS)).toBe(true);
    for (const tool of runnerToolsForRole(DEPLOY_VERIFIER_ROLE)) expect(tool).not.toMatch(/Bash|Edit|Write|Web|curl/);
  });

  it("leaves every other role's list as it was", () => {
    expect(() => runnerToolsForRole("made-up")).toThrow(UnknownRoleError);
    expect(runnerToolsForRole("executor")).toBe(toolsForRole("executor"));
  });
});
