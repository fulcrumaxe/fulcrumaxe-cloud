import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MACOS_PREVIEW_LABEL, MACOS_PREVIEW_NOTICE, PLATFORM_SUPPORT, WINDOWS_UNSUPPORTED_NOTICE, platformRow, WSL1_CONVERT_NOTICE } from "../src/platformSupport.js";
import { SandboxRefused, detectPlatform } from "../src/sandbox/platform.js";
import { WSL_CODES } from "../src/sandbox/wslChecks.js";
import { PACKAGE_DIR, srcFiles } from "./helpers/srcFiles.js";

/** The table's one source file lives in the protocol package (the cloud reads the same rows); the runner's `src/platformSupport.ts` only re-exports it, so a phrase is spelled once in that file and in no runner source. */
const TABLE_FILE = readFileSync(path.join(PACKAGE_DIR, "..", "runner-protocol", "src", "platformSupport.ts"), "utf8");
const spelledOnce = (phrase: string): void => {
  expect(srcFiles().filter(([, text]) => text.includes(phrase))).toEqual([]);
  expect(TABLE_FILE.split(phrase).length - 1).toBeGreaterThanOrEqual(1);
};

const readme = readFileSync(path.join(PACKAGE_DIR, "README.md"), "utf8");
/** The README's matrix rows as [platform, status]. */
const matrix = [...readme.matchAll(/^\| (.+?) \| (.+?) \|$/gm)].map((m): [string, string] => [m[1]!, m[2]!]).filter(([platform]) => platform !== "Platform" && !platform.startsWith("---"));

describe("the macOS preview label lives in one place", () => {
  it("is spelled once in src, in platformSupport.ts, and nowhere else", () => {
    expect(MACOS_PREVIEW_LABEL).toBe("preview, not yet verified");
    spelledOnce("not yet verified");
    expect(TABLE_FILE.match(/const MACOS_PREVIEW_LABEL = "preview, not yet verified"/g)).toHaveLength(1);
  });

  it("the README states exactly the notice the program prints", () => {
    expect(readme).toContain(MACOS_PREVIEW_NOTICE);
    expect(matrix.find(([platform]) => platform.startsWith("macOS"))?.[1]).toContain(`**${MACOS_PREVIEW_LABEL}**`);
  });
});

describe("the Windows notice lives in one place", () => {
  it("is spelled once in src, in platformSupport.ts", () => {
    spelledOnce("does not support native Windows");
    expect(WINDOWS_UNSUPPORTED_NOTICE).toBe("fx-runner does not support native Windows. Install it inside WSL2, or on Linux or macOS.");
  });
});

describe("the README's support matrix", () => {
  it("is exactly the table in platformSupport.ts, row for row (drift fails here)", () => {
    expect(matrix).toEqual(PLATFORM_SUPPORT.map((row): [string, string] => [row.name, row.label]));
  });

  it("states macOS as a preview, Linux and WSL2 as supported, and native Windows and WSL1 as not supported", () => {
    expect(PLATFORM_SUPPORT.map((row) => [row.id, row.status])).toEqual([["macos", "preview"], ["linux", "supported"], ["windows", "not_supported"], ["wsl2", "supported"], ["wsl1", "not_supported"]]);
    expect(matrix.find(([platform]) => platform === "WSL2")?.[1]).toBe("supported, OS sandbox only, NAT networking (see below)");
    expect(matrix.find(([platform]) => platform === "WSL2")?.[1]).not.toContain(MACOS_PREVIEW_LABEL);
  });

  it("WSL2 says VM mode is not offered, once, in the row; doctor and the README read it", () => {
    expect(platformRow("wsl2").vmNotice).toBe("VM mode not supported");
    expect(PLATFORM_SUPPORT.filter((row) => row.vmNotice !== undefined).map((row) => row.id)).toEqual(["wsl2"]);
  });

  it("never shows a platform as supported before it is: only Linux and WSL2 (NAT, proven) are supported", () => {
    expect(PLATFORM_SUPPORT.filter((row) => row.status === "supported").map((row) => row.id)).toEqual(["linux", "wsl2"]);
  });

  it("the runner refuses with the notice the row holds, for every row that refuses", () => {
    const probes = { windows: { platform: "win32" }, wsl2: { platform: "linux", osrelease: "5.15.167.4-microsoft-standard-WSL2" }, wsl1: { platform: "linux", osrelease: "4.4.0-19041-Microsoft" } } as const;
    for (const row of PLATFORM_SUPPORT.filter((candidate) => candidate.refusalCode !== undefined)) {
      let refusal: unknown;
      try {
        detectPlatform(probes[row.id as keyof typeof probes]);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(SandboxRefused);
      expect((refusal as SandboxRefused).code).toBe(row.refusalCode);
      expect((refusal as SandboxRefused).message).toBe(`${row.refusalCode}: ${row.notice}`);
    }
  });

  it("rows that run jobs carry no refusal", () => {
    expect(PLATFORM_SUPPORT.filter((row) => row.refusalCode === undefined).map((row) => row.id)).toEqual(["macos", "linux"]);
  });

  it("gives one install path per OS", () => {
    expect(readme).toMatch(/one install path per OS/);
    expect(readme).not.toMatch(/WSL2 uses the Linux one/);
  });

  it("the README states exactly the Windows notice the program prints", () => {
    expect(readme).toContain(WINDOWS_UNSUPPORTED_NOTICE);
  });

  it("the README states exactly the WSL1 copy the program prints, with the conversion command", () => {
    expect(readme).toContain(WSL1_CONVERT_NOTICE);
    expect(WSL1_CONVERT_NOTICE).toContain("wsl --set-version <distro> 2");
  });

  it("the README states the interop cost and the exact wsl.conf lines doctor looks for", () => {
    expect(readme).toContain("no `.exe` launches from WSL2 while the runner is installed");
    expect(readme).toContain("[interop]\nenabled=false\nappendWindowsPath=false");
  });

  it("the README names every closed WSL doctor code", () => {
    for (const code of WSL_CODES) expect(readme).toContain(`\`${code}\``);
  });

  it("the WSL1 copy is spelled once in src, in platformSupport.ts", () => {
    spelledOnce("Convert the distribution");
  });
});
