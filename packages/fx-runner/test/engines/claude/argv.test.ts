import { createClaudeCodeBackend } from "@fx/runtime/src/backends/claudeCode.js";
import { describe, expect, it } from "vitest";
import { REQUIRED_FLAGS, baseToolNames, claudeArgv } from "../../../src/engines/claude/argv.js";
import { roleToolsFor } from "../../../src/job/roleTools.js";

const input = { cliModel: "sonnet", roleTools: roleToolsFor("code-reviewer"), settingsPath: "/jobs/r/settings.json", mcpPath: "/jobs/r/mcp.json" };

describe("argv", () => {
  it("fresh run: exactly the documented flags, in order (snapshot)", () => {
    expect(claudeArgv(input)).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", "/jobs/r/settings.json",
      "--strict-mcp-config", "--mcp-config", "/jobs/r/mcp.json", "--tools", "Read,Glob,Grep,LS,Bash",
      "--disallowedTools", "WebFetch", "WebSearch", "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--disable-slash-commands", "--model", "sonnet",
    ]);
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
  });

  it("uses none of the flags it must never use", () => {
    const banned = ["--bare", "--no-session-persistence", "--fork-session", ["--dangerously", "skip-permissions"].join("-"), "--permission-prompt-tool"];
    for (const argv of [claudeArgv(input), claudeArgv({ ...input, resumeSessionId: "s-1" })]) for (const flag of banned) expect(argv).not.toContain(flag);
  });

  it("--tools is the distinct base names of the role entry", () => {
    expect(baseToolNames(["Read", "Bash(git:*)", "Bash(ls:*)", "Edit", "Bash(pwd)"])).toEqual(["Read", "Bash", "Edit"]);
  });

  it("REQUIRED_FLAGS is exactly the set of flags the argument list uses, so the --help check cannot drift from it", () => {
    const used = claudeArgv({ ...input, resumeSessionId: "s-1" }).filter((part) => /^-/.test(part) && part !== "");
    expect([...new Set(used)].sort()).toEqual([...REQUIRED_FLAGS].sort());
  });
});
