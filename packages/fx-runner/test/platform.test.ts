import { describe, expect, it } from "vitest";
import { WINDOWS_UNSUPPORTED_NOTICE } from "../src/platformSupport.js";
import { SandboxRefused, classifyLinuxKernel, WINDOWS_REFUSAL, detectPlatform } from "../src/sandbox/platform.js";

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
    ["6.8.0-45-generic", "linux"],
    ["6.1.0-nixos", "linux"],
  ])("Linux kernel %s is %s", (osrelease, expected) => {
    expect(detectPlatform({ platform: "linux", osrelease })).toBe(expected);
  });

  it.each(["5.15.167.4-microsoft-standard-WSL2", "4.19.128-microsoft-standard", "5.10.16.3-WSL2"])("WSL2 kernel %s is refused wsl2_unsupported, never returned as a platform", (osrelease) => {
    const error = refusal({ platform: "linux", osrelease });
    expect(error.code).toBe("wsl2_unsupported");
    expect(error.message).toContain(WINDOWS_UNSUPPORTED_NOTICE);
  });

  it("the WSL2 kernel is still classified (v2 reuses it)", () => {
    expect(classifyLinuxKernel("5.15.167.4-microsoft-standard-WSL2")).toBe("wsl2");
    expect(classifyLinuxKernel("4.4.0-19041-Microsoft")).toBe("wsl1");
    expect(classifyLinuxKernel("6.8.0-45-generic")).toBe("linux");
  });

  it("WSL1 (a bare Microsoft kernel) is refused with the same message", () => {
    const error = refusal({ platform: "linux", osrelease: "4.4.0-19041-Microsoft" });
    expect(error.code).toBe("wsl1_unsupported");
    expect(error.message).toContain(WINDOWS_REFUSAL);
  });

  it("native Windows is refused, and macOS is accepted without reading the kernel string", () => {
    expect(refusal({ platform: "win32" }).code).toBe("windows_unsupported");
    expect(refusal({ platform: "win32" }).message).toContain(WINDOWS_UNSUPPORTED_NOTICE);
    expect(detectPlatform({ platform: "darwin" })).toBe("macos");
  });

  it("any other platform is refused", () => {
    expect(refusal({ platform: "freebsd" }).code).toBe("unsupported_platform");
  });
});
