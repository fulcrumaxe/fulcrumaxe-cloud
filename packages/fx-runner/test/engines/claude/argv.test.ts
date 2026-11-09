import { createClaudeCodeBackend } from "@fx/runtime/src/backends/claudeCode.js";
import { describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
import { REQUIRED_FLAGS, baseToolNames, claudeArgv } from "../../../src/engines/claude/argv.js";
import { roleToolsFor } from "../../../src/job/roleTools.js";

const allowRules = ["Read(//ws)", "Read(//ws/**)", "Glob", "Bash(git:*)"];
const input = { cliModel: "sonnet", roleTools: roleToolsFor("code-reviewer"), allowRules, settingsPath: "/jobs/r/settings.json", mcpPath: "/jobs/r/mcp.json" };

describe("argv", () => {
  it("fresh run: exactly the documented flags, in order (snapshot)", () => {
    expect(claudeArgv(input)).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", "/jobs/r/settings.json",
      "--strict-mcp-config", "--mcp-config", "/jobs/r/mcp.json", "--no-chrome", "--tools", "Read,Glob,Grep,LS,Bash",
      "--allowedTools", ...allowRules, "--disallowedTools", "WebFetch", "WebSearch", "--permission-prompts", "none",
      "--disable-slash-commands", "--model", "sonnet",
    ]);
  });

  it("declares the allowed tools instead of asking for a permission mode: the CLI forces `default` under the env scrub and warns about any other", () => {
    for (const argv of [claudeArgv(input), claudeArgv({ ...input, resumeSessionId: "s-1" })]) {
      expect(argv).not.toContain("--permission-mode");
      expect(argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"))).toEqual(allowRules);
      expect(argv[argv.indexOf("--permission-prompts") + 1]).toBe("none");
    }
  });

  it("with no allow rules the flag is left out, so it never swallows the next flag", () => {
    const argv = claudeArgv({ ...input, allowRules: [] });
    expect(argv).not.toContain("--allowedTools");
    expect(argv[argv.indexOf("--tools") + 2]).toBe("--disallowedTools");
  });

  it("resume: the same flags plus --resume <id> at the end", () => {
    const fresh = claudeArgv(input);
    expect(claudeArgv({ ...input, resumeSessionId: "sess-0001" })).toEqual([...fresh, "--resume", "sess-0001"]);
  });

  it("holds every flag group the cloud's hostile-config contract requires", () => {
    const backend = createClaudeCodeBackend({ cliVersion: "2.1.273", cliSha256: "0".repeat(64), settingsPath: input.settingsPath, mcpPath: input.mcpPath });
    const argv = claudeArgv(input);
    for (const group of backend.hostileConfig.requiredArgv) {
      const at = argv.findIndex((_, i) => group.every((part, k) => argv[i + k] === part));
      expect(at, group.join(" ")).toBeGreaterThanOrEqual(0);
    }
  });

  it("each variadic flag is followed by a flag, which ends it", () => {
    const argv = claudeArgv(input);
    expect(argv[argv.indexOf("--mcp-config") + 2]).toMatch(/^--/);
    expect(argv[argv.indexOf("--disallowedTools") + 3]).toMatch(/^--/);
    expect(argv[argv.indexOf("--allowedTools") + 1 + allowRules.length]).toBe("--disallowedTools");
  });

  it("uses none of the flags it must never use", () => {
    const banned = ["--bare", "--no-session-persistence", "--fork-session", ["--dangerously", "skip-permissions"].join("-"), "--permission-prompt-tool"];
    for (const argv of [claudeArgv(input), claudeArgv({ ...input, resumeSessionId: "s-1" })]) for (const flag of banned) expect(argv).not.toContain(flag);
  });

  it("--tools is the distinct base names of the role entry", () => {
    expect(baseToolNames(["Read", "Bash(git:*)", "Bash(ls:*)", "Edit", "Bash(pwd)"])).toEqual(["Read", "Bash", "Edit"]);
  });

  it("REQUIRED_FLAGS is exactly the set of flags the argument list uses (with and without the browser), so the --help check cannot drift from it", () => {
    const flags = (argv: string[]): string[] => argv.filter((part) => /^-/.test(part) && part !== "");
    const used = [...flags(claudeArgv({ ...input, resumeSessionId: "s-1" })), ...flags(claudeArgv({ ...input, chrome: true }))];
    expect([...new Set(used)].sort()).toEqual([...REQUIRED_FLAGS].sort());
  });

  // D#749 V2b: the CLI reaches the Claude in Chrome extension through its own flag. `--chrome` rides only a browser job; every other job pins `--no-chrome`, so a person's own
  // "Chrome on by default" setting cannot bring the browser tools to a job that does not hold them. The MCP file stays empty and `--strict-mcp-config` stays on in both.
  describe("the browser flag", () => {
    const withRole = (role: string, resumeSessionId?: string) => claudeArgv({ ...input, roleTools: roleToolsFor(role), chrome: role === DEPLOY_VERIFIER_ROLE, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });

    it("--chrome appears for the deploy verifier and for no other role, on a fresh run and on a resume", () => {
      expect(RUNNER_ELIGIBLE_ROLES).toContain(DEPLOY_VERIFIER_ROLE);
      for (const role of RUNNER_ELIGIBLE_ROLES) {
        for (const argv of [withRole(role), withRole(role, "s-1")]) {
          expect(argv.includes("--chrome"), role).toBe(role === DEPLOY_VERIFIER_ROLE);
          expect(argv.includes("--no-chrome"), role).toBe(role !== DEPLOY_VERIFIER_ROLE);
          expect(argv, role).toContain("--strict-mcp-config");
        }
      }
    });

    it("the browser flag sits right after the MCP file, so the variadic --mcp-config is ended by a flag", () => {
      for (const chrome of [true, false]) {
        const argv = claudeArgv({ ...input, chrome });
        expect(argv.slice(argv.indexOf("--mcp-config") + 1, argv.indexOf("--mcp-config") + 3)).toEqual([input.mcpPath, chrome ? "--chrome" : "--no-chrome"]);
      }
    });

    it("an absent or false chrome option is the pinned off", () => {
      expect(claudeArgv(input)).toContain("--no-chrome");
      expect(claudeArgv({ ...input, chrome: false })).toContain("--no-chrome");
      expect(claudeArgv(input)).not.toContain("--chrome");
    });

    it("--tools lists the CLI's built-in tools only; the browser tools are granted by their allow rules alone", () => {
      const entry = roleToolsFor(DEPLOY_VERIFIER_ROLE);
      expect(baseToolNames(entry)).toEqual(["Read", "Glob", "Grep"]);
      const argv = claudeArgv({ ...input, roleTools: entry, allowRules: [...entry], chrome: true });
      expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
      expect(argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"))).toEqual([...entry]);
      for (const tool of DEPLOY_VERIFIER_BROWSER_TOOLS) expect(argv[argv.indexOf("--tools") + 1]).not.toContain(tool);
    });
  });
});
