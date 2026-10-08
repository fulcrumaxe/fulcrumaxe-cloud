import { describe, expect, it } from "vitest";
import type { SandboxRefused } from "../src/sandbox/platform.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { commandOnPath, selectTier } from "../src/sandbox/select.js";

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
  it("Linux and WSL2 with bubblewrap and socat get host_sandbox", () => {
    expect(selectTier({ ...linux, hasCommand: has("bwrap", "socat") })).toBe("host_sandbox");
    expect(selectTier({ platform: "linux", osrelease: "5.15.167.4-microsoft-standard-WSL2", hasCommand: has("bwrap", "socat") })).toBe("host_sandbox");
  });

  it("macOS needs no extra tool", () => {
    expect(selectTier({ platform: "darwin", hasCommand: has() })).toBe("host_sandbox");
  });

  it("a missing dependency is a refusal that names it", () => {
    expect(code(() => selectTier({ ...linux, hasCommand: has("socat") }))).toBe("bubblewrap_missing");
    expect(code(() => selectTier({ ...linux, hasCommand: has("bwrap") }))).toBe("socat_missing");
  });

  it("Windows and WSL1 are refused whatever is installed", () => {
    expect(code(() => selectTier({ platform: "win32", hasCommand: has("bwrap", "socat") }))).toBe("windows_unsupported");
    expect(code(() => selectTier({ platform: "linux", osrelease: "4.4.0-19041-Microsoft", hasCommand: has("bwrap", "socat") }))).toBe("wsl1_unsupported");
  });

  it("the default probe finds a real command and misses an absent one", () => {
    const pathValue = cleanEnv({ mode: "subscription" }).PATH ?? "";
    expect(commandOnPath("sh", pathValue)).toBe(true);
    expect(commandOnPath("fx-no-such-command-0001", pathValue)).toBe(false);
    expect(commandOnPath("sh", "")).toBe(false);
  });
});
