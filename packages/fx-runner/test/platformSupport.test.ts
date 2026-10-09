import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MACOS_PREVIEW_LABEL, MACOS_PREVIEW_NOTICE } from "../src/platformSupport.js";
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

describe("the README's support matrix", () => {
  it("lists the supported platforms, WSL2 on the Linux install, and the two unsupported ones", () => {
    expect(matrix).toEqual([
      ["macOS arm64 and x64", "supported as a **preview, not yet verified** (see below)"],
      ["Linux x64 and arm64", "supported"],
      ["Windows 10 and 11 through WSL2 (x64 and arm64)", "supported, using the Linux install inside WSL2"],
      ["Native Windows", "not supported"],
      ["WSL1", "not supported"],
    ]);
  });

  it("gives one install path per OS", () => {
    expect(readme).toMatch(/one install path per OS/);
    expect(readme).toMatch(/WSL2 uses the Linux one/);
  });
});
