import { describe, expect, it } from "vitest";
import { WINDOWS_UNSUPPORTED_NOTICE, WSL1_CONVERT_NOTICE, WSL2_NOT_CLEARED_NOTICE } from "../src/platformSupport.js";
import { SandboxRefused, classifyLinuxKernel, detectPlatform, interopEntryPresent, linuxKernel } from "../src/sandbox/platform.js";

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
    expect(error.message).toContain(WSL2_NOT_CLEARED_NOTICE);
  });

  it("the WSL2 kernel is still classified (v2 reuses it)", () => {
    expect(classifyLinuxKernel("5.15.167.4-microsoft-standard-WSL2")).toBe("wsl2");
    expect(classifyLinuxKernel("4.4.0-19041-Microsoft")).toBe("wsl1");
    expect(classifyLinuxKernel("6.8.0-45-generic")).toBe("linux");
  });

  it("WSL1 (a bare Microsoft kernel) is refused with the conversion copy", () => {
    const error = refusal({ platform: "linux", osrelease: "4.4.0-19041-Microsoft" });
    expect(error.code).toBe("wsl1_unsupported");
    expect(error.message).toContain(WSL1_CONVERT_NOTICE);
    expect(error.message).toContain("wsl --set-version <distro> 2");
  });

  it("a kernel with a custom name is WSL2 when the WSLInterop entry exists, and plain Linux when it does not", () => {
    expect(refusal({ platform: "linux", osrelease: "6.6.0-custom", wslInterop: true }).code).toBe("wsl2_unsupported");
    expect(detectPlatform({ platform: "linux", osrelease: "6.6.0-custom", wslInterop: false })).toBe("linux");
    expect(classifyLinuxKernel("6.6.0-custom", true)).toBe("wsl2");
    expect(refusal({ platform: "linux", osrelease: "4.4.0-19041-Microsoft", wslInterop: true }).code).toBe("wsl2_unsupported");
  });

  it("with no kernel string given (the real os.release() path), the interop entry alone still makes WSL2 and its absence leaves plain Linux", () => {
    expect(refusal({ platform: "linux", wslInterop: true }).code).toBe("wsl2_unsupported");
    expect(detectPlatform({ platform: "linux", wslInterop: false })).toBe("linux");
    expect(detectPlatform({ platform: "linux" })).toBe("linux");
    expect(linuxKernel({ wslInterop: true })).toBe("wsl2");
  });

  it("the interop entry check: either name counts, only a missing entry means absent, any other error refuses", () => {
    const missing = (code: string) => (): never => {
      throw Object.assign(new Error("stat"), { code });
    };
    const only = (present: string) => (name: string): void => {
      if (name !== present) missing("ENOENT")();
    };
    expect(interopEntryPresent(missing("ENOENT"))).toBe(false);
    expect(interopEntryPresent(missing("ENOTDIR"))).toBe(false);
    expect(interopEntryPresent(only("WSLInterop"))).toBe(true);
    expect(interopEntryPresent(only("WSLInterop-late"))).toBe(true);
    expect(interopEntryPresent(missing("EACCES"))).toBe(true);
    expect(interopEntryPresent(() => {
      throw new Error("no code");
    })).toBe(true);
  });

  it("WSL_DISTRO_NAME alone never makes a WSL2 (the kernel and the interop entry decide)", () => {
    const before = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    try {
      expect(detectPlatform({ platform: "linux", osrelease: "6.8.0-45-generic" })).toBe("linux");
    } finally {
      if (before === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = before;
    }
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
