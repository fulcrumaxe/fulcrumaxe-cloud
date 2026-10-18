import { describe, expect, it } from "vitest";
import { buildSandboxEnv, isForbiddenSandboxEnvName } from "../src/sandboxEnv.js";
import type { Role } from "../src/types.js";

describe("D#600 CX-6a: the context levers in the sandbox env", () => {
  const AGENT_ROLES = ["executor", "code-reviewer", "security-reviewer", "project-manager", "acceptance-tester", "researcher"] as Role[];

  it("every agent role, in both modes, carries the two fixed constants, and neither name looks like a credential", () => {
    for (const role of AGENT_ROLES) {
      for (const mode of ["tenant_key", "operator_subscription"] as const) {
        const env = buildSandboxEnv(role, mode);
        expect(env.BASH_MAX_OUTPUT_LENGTH, `${role}/${mode}`).toBe("30000");
        expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, `${role}/${mode}`).toBe("85");
      }
    }
    for (const name of ["BASH_MAX_OUTPUT_LENGTH", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]) expect(isForbiddenSandboxEnvName(name)).toBe(false);
  });

  it("the publish role has no model, so it gets neither", () => {
    const env = buildSandboxEnv("plane_publish" as Role);
    expect(env).not.toHaveProperty("BASH_MAX_OUTPUT_LENGTH");
    expect(env).not.toHaveProperty("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
  });
});
