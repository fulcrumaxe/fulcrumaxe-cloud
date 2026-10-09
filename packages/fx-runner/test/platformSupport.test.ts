import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MACOS_PREVIEW_LABEL, MACOS_PREVIEW_NOTICE, WINDOWS_UNSUPPORTED_NOTICE } from "../src/platformSupport.js";
import { PACKAGE_DIR, srcFiles } from "./helpers/srcFiles.js";

const readme = readFileSync(path.join(PACKAGE_DIR, "README.md"), "utf8");
/** The README's matrix rows as [platform, status]. */
const matrix = [...readme.matchAll(/^\| (.+?) \| (.+?) \|$/gm)].map((m): [string, string] => [m[1]!, m[2]!]).filter(([platform]) => platform !== "Platform" && !platform.startsWith("---"));

describe("the macOS preview label lives in one place", () => {
  it("is spelled once in src, in platformSupport.ts, and nowhere else", () => {
    expect(MACOS_PREVIEW_LABEL).toBe("preview, not yet verified");
    const files = srcFiles().filter(([, text]) => text.includes("not yet verified"));
    expect(files.map(([name]) => name)).toEqual(["src/platformSupport.ts"]);
  });

  it("the README states exactly the notice the program prints", () => {
    expect(readme).toContain(MACOS_PREVIEW_NOTICE);
    expect(matrix.find(([platform]) => platform.startsWith("macOS"))?.[1]).toContain(`**${MACOS_PREVIEW_LABEL}**`);
  });
});

describe("the Windows notice lives in one place", () => {
  it("is spelled once in src, in platformSupport.ts", () => {
    const files = srcFiles().filter(([, text]) => text.includes("does not support Windows yet"));
    expect(files.map(([name]) => name)).toEqual(["src/platformSupport.ts"]);
    expect(WINDOWS_UNSUPPORTED_NOTICE).toBe("fx-runner does not support Windows yet, including WSL2. Linux and macOS are supported.");
  });
});

describe("the README's support matrix", () => {
  it("lists macOS and Linux as supported, and native Windows, WSL2 and WSL1 as not", () => {
    expect(matrix).toEqual([
      ["macOS arm64 and x64", "supported as a **preview, not yet verified** (see below)"],
      ["Linux x64 and arm64", "supported"],
      ["Native Windows", "not supported"],
      ["WSL2", "not supported"],
      ["WSL1", "not supported"],
    ]);
  });

  it("gives one install path per OS", () => {
    expect(readme).toMatch(/one install path per OS/);
    expect(readme).not.toMatch(/WSL2 uses the Linux one/);
  });

  it("the README states exactly the Windows notice the program prints", () => {
    expect(readme).toContain(WINDOWS_UNSUPPORTED_NOTICE);
  });
});
