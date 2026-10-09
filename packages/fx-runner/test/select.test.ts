import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SandboxRefused } from "../src/sandbox/platform.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { commandOnPath, resolveSandboxTools, sandboxToolDirs, selectTier } from "../src/sandbox/select.js";

const linux = { platform: "linux", osrelease: "6.8.0-45-generic" };
const has = (...names: string[]) => (name: string) => names.includes(name);

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as SandboxRefused).code;
  }
  return "no refusal";
}

describe("tier selection: host_sandbox or a refusal, never an unsandboxed run", () => {
  it("Linux with bubblewrap and socat gets host_sandbox", () => {
    expect(selectTier({ ...linux, hasCommand: has("bwrap", "socat") })).toBe("host_sandbox");
  });

  it("macOS needs no extra tool", () => {
    expect(selectTier({ platform: "darwin", hasCommand: has() })).toBe("host_sandbox");
  });

  it("a missing dependency is a refusal that names it", () => {
    expect(code(() => selectTier({ ...linux, hasCommand: has("socat") }))).toBe("bubblewrap_missing");
    expect(code(() => selectTier({ ...linux, hasCommand: has("bwrap") }))).toBe("socat_missing");
  });

  it("Windows, WSL1 and WSL2 are refused whatever is installed", () => {
    expect(code(() => selectTier({ platform: "win32", hasCommand: has("bwrap", "socat") }))).toBe("windows_unsupported");
    expect(code(() => selectTier({ platform: "linux", osrelease: "4.4.0-19041-Microsoft", hasCommand: has("bwrap", "socat") }))).toBe("wsl1_unsupported");
    expect(code(() => selectTier({ platform: "linux", osrelease: "5.15.167.4-microsoft-standard-WSL2", hasCommand: has("bwrap", "socat") }))).toBe("wsl2_unsupported");
    expect(code(() => resolveSandboxTools("", { platform: "linux", osrelease: "5.15.167.4-microsoft-standard-WSL2" }))).toBe("wsl2_unsupported");
  });

  describe("the sandbox tools are found at setup as absolute paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tan_tools-"));
    const store = (name: string, tools: string[]): string => {
      const dir = path.join(root, name, "bin");
      mkdirSync(dir, { recursive: true });
      for (const tool of tools) writeFileSync(path.join(dir, tool), "#!/bin/sh\n", { mode: 0o755 });
      return dir;
    };
    const bwrapDir = store("bubblewrap", ["bwrap"]);
    const socatDir = store("socat", ["socat"]);
    const both = store("both", ["bwrap", "socat"]);
    const search = (...dirs: string[]): string => dirs.join(path.delimiter);

    it("finds each tool in the directory that holds it, even when they are in different store paths", () => {
      const tools = resolveSandboxTools(search("relative/bin", bwrapDir, socatDir), linux);
      expect(tools).toEqual({ bwrap: path.join(bwrapDir, "bwrap"), socat: path.join(socatDir, "socat") });
      expect(sandboxToolDirs(tools)).toEqual([bwrapDir, socatDir]);
    });

    it("one directory holding both is listed once, and the first directory on the path wins", () => {
      const tools = resolveSandboxTools(search(both, bwrapDir, socatDir), linux);
      expect(sandboxToolDirs(tools)).toEqual([both]);
    });

    it("keeps refusing a machine where one is missing, naming it, like the tier check", () => {
      expect(code(() => resolveSandboxTools(search(socatDir), linux))).toBe("bubblewrap_missing");
      expect(code(() => resolveSandboxTools(search(bwrapDir), linux))).toBe("socat_missing");
      expect(code(() => resolveSandboxTools("", linux))).toBe("bubblewrap_missing");
    });

    it("a file that is not executable, or a directory called bwrap, is not a tool", () => {
      const odd = path.join(root, "odd", "bin");
      mkdirSync(path.join(odd, "bwrap"), { recursive: true });
      writeFileSync(path.join(odd, "socat"), "x", { mode: 0o644 });
      expect(code(() => resolveSandboxTools(search(odd), linux))).toBe("bubblewrap_missing");
      expect(code(() => resolveSandboxTools(search(bwrapDir, odd), linux))).toBe("socat_missing");
    });

    it("macOS needs none and adds nothing to the path; Windows is still refused", () => {
      expect(resolveSandboxTools("", { platform: "darwin" })).toBeUndefined();
      expect(sandboxToolDirs(undefined)).toEqual([]);
      expect(code(() => resolveSandboxTools(search(both), { platform: "win32" }))).toBe("windows_unsupported");
    });

    it("the directories it finds are what makes the tools visible on the agent's clean PATH", () => {
      vi.stubEnv("PATH", "/nowhere/bin");
      try {
        const tools = resolveSandboxTools(search(bwrapDir, socatDir), linux);
        const pathValue = cleanEnv({ mode: "subscription" }, { extraPathDirs: sandboxToolDirs(tools) }).PATH ?? "";
        expect(commandOnPath("bwrap", pathValue)).toBe(true);
        expect(commandOnPath("socat", pathValue)).toBe(true);
        expect(commandOnPath("bwrap", cleanEnv({ mode: "subscription" }).PATH ?? "")).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("the default probe finds a real command and misses an absent one", () => {
    const pathValue = cleanEnv({ mode: "subscription" }).PATH ?? "";
    expect(commandOnPath("sh", pathValue)).toBe(true);
    expect(commandOnPath("fx-no-such-command-0001", pathValue)).toBe(false);
    expect(commandOnPath("sh", "")).toBe(false);
  });
});
