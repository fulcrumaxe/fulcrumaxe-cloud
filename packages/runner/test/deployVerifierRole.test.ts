import { describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_BROWSER_TOOLS, DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, DEPLOY_VERIFIER_RUNNER_TOOLS, RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
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

  it("has no sandbox tool list: toolsForRole and agentSettingsFor refuse it though it is a confined read role, and it is not a platform role", () => {
    expect(() => toolsForRole(DEPLOY_VERIFIER_ROLE)).toThrow(UnknownRoleError);
    expect(() => agentSettingsFor(DEPLOY_VERIFIER_ROLE)).toThrow(UnknownRoleError);
    expect(TOOL_LISTED_ROLES).not.toContain(DEPLOY_VERIFIER_ROLE);
    expect(PLATFORM_ROLES).not.toContain(DEPLOY_VERIFIER_ROLE);
    // D#749 V2b: a member, so a local runner gives it the read guard and the dot-git and dot-env denies (its page text is an outsider's).
    expect(CONFINED_READ_ROLES.has(DEPLOY_VERIFIER_ROLE)).toBe(true);
  });

  it("is signed with Read, Glob, Grep and the browser tools: nothing that writes, runs a command or reaches the web", () => {
    expect([...runnerToolsForRole(DEPLOY_VERIFIER_ROLE)]).toEqual(["Read", "Glob", "Grep", ...DEPLOY_VERIFIER_BROWSER_TOOLS]);
    expect(runnerToolsForRole(DEPLOY_VERIFIER_ROLE)).toBe(DEPLOY_VERIFIER_RUNNER_TOOLS);
    expect(Object.isFrozen(DEPLOY_VERIFIER_RUNNER_TOOLS)).toBe(true);
    for (const tool of runnerToolsForRole(DEPLOY_VERIFIER_ROLE)) expect(tool).not.toMatch(/Bash|Edit|Write|Web|curl/);
  });

  // D#749 V2c-1: the list the job is signed with depends on the method the cloud chose for it.
  it("is signed with the list of its browser method: Chrome's (also when no method is given) or the fxverify tools, never both", () => {
    expect(runnerToolsForRole(DEPLOY_VERIFIER_ROLE, "chrome_runner")).toBe(DEPLOY_VERIFIER_RUNNER_TOOLS);
    expect([...runnerToolsForRole(DEPLOY_VERIFIER_ROLE, "playwright_runner")]).toEqual(["Read", "Glob", "Grep", ...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS]);
    expect(runnerToolsForRole(DEPLOY_VERIFIER_ROLE, "playwright_runner")).not.toEqual(runnerToolsForRole(DEPLOY_VERIFIER_ROLE, "chrome_runner"));
    for (const tool of runnerToolsForRole(DEPLOY_VERIFIER_ROLE, "playwright_runner")) expect(tool).not.toMatch(/Bash|Edit|Write|Web|curl|claude-in-chrome/);
  });

  it("gives a method to no other role: another role's list is the same whatever method is passed", () => {
    expect(runnerToolsForRole("executor", "playwright_runner")).toBe(toolsForRole("executor"));
  });

  it("leaves every other role's list as it was", () => {
    expect(() => runnerToolsForRole("made-up")).toThrow(UnknownRoleError);
    expect(runnerToolsForRole("executor")).toBe(toolsForRole("executor"));
  });
});
