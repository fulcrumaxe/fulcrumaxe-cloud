import { describe, expect, it } from "vitest";
import { SandboxRefused, WINDOWS_REFUSAL, detectPlatform } from "../src/sandbox/platform.js";

function refusal(probe: Parameters<typeof detectPlatform>[0]): SandboxRefused {
  try {
    detectPlatform(probe);
  } catch (error) {
    return error as SandboxRefused;
  }
  throw new Error("expected a refusal");
}

describe("platform detection", () => {
  it.each([
    ["5.15.167.4-microsoft-standard-WSL2", "wsl2"],
    ["4.19.128-microsoft-standard", "wsl2"],
    ["6.8.0-45-generic", "linux"],
    ["6.1.0-nixos", "linux"],
  ])("Linux kernel %s is %s", (osrelease, expected) => {
    expect(detectPlatform({ platform: "linux", osrelease })).toBe(expected);
  });

  it("WSL1 (a bare Microsoft kernel) is refused with the Windows message", () => {
    const error = refusal({ platform: "linux", osrelease: "4.4.0-19041-Microsoft" });
    expect(error.code).toBe("wsl1_unsupported");
    expect(error.message).toContain(WINDOWS_REFUSAL);
  });

  it("native Windows is refused, and macOS is accepted without reading the kernel string", () => {
    expect(refusal({ platform: "win32" }).code).toBe("windows_unsupported");
    expect(detectPlatform({ platform: "darwin" })).toBe("macos");
  });

  it("any other platform is refused", () => {
    expect(refusal({ platform: "freebsd" }).code).toBe("unsupported_platform");
  });
});
