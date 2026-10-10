import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARTIFACT_NAMES } from "../../scripts/release-manifest.mjs";
import { checksumsText, loadManifest, renderTemplate } from "../../scripts/release-render.mjs";

// D#6 R6-5: the release copies of install.sh and the Homebrew formula are rendered from the manifest, and a leftover placeholder is refused.
const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = path.join(PACKAGE, "scripts");
const INSTALL_SH = path.join(PACKAGE, "install.sh");
const FORMULA = path.join(PACKAGE, "..", "..", "packaging", "homebrew", "fx-runner.rb.tmpl");
const PLATFORMS = Object.keys(ARTIFACT_NAMES) as string[];

let root: string;
let manifestFile: string;
const hashes = new Map<string, string>();

const run = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "fx-render-"));
  // Real files, and the real manifest tool: the formula's checksums must be the ones this manifest computed.
  for (const [platform, name] of Object.entries(ARTIFACT_NAMES) as [string, string][]) {
    writeFileSync(path.join(root, name), `binary for ${platform}`);
    hashes.set(platform, createHash("sha256").update(`binary for ${platform}`).digest("hex"));
  }
  const made = run("release-manifest.mjs", ["--dir", root, "--version", "1.2.3"]);
  expect(made.status).toBe(0);
  manifestFile = path.join(root, "release-manifest.json");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("install.sh rendering", () => {
  it("fills the version and all four hashes from the manifest, leaving no placeholder, in a script that still parses", () => {
    const out = path.join(root, "install.out.sh");
    const result = run("release-render.mjs", ["install", "--manifest", manifestFile, "--template", INSTALL_SH, "--out", out]);
    expect(result.status).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("@FX_");
    expect(text).toContain('FX_VERSION="1.2.3"');
    for (const platform of PLATFORMS) expect(text).toContain(`FX_SHA256_${platform.toUpperCase().replace("-", "_")}="${hashes.get(platform)}"`);
    expect(spawnSync("sh", ["-n", out]).status).toBe(0);
  });

  it("refuses a template with a placeholder the manifest cannot fill, and writes nothing", () => {
    const template = path.join(root, "bad-template.sh");
    writeFileSync(template, `${readFileSync(INSTALL_SH, "utf8")}\n# @FX_SHA256_FREEBSD_X64@\n`);
    const out = path.join(root, "bad.out.sh");
    const result = run("release-render.mjs", ["install", "--manifest", manifestFile, "--template", template, "--out", out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("placeholders left after rendering: @FX_SHA256_FREEBSD_X64@");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a manifest that is missing a platform, has a bad hash, or mixes versions", () => {
    const entries = JSON.parse(readFileSync(manifestFile, "utf8")) as { version: string; platform: string; sha256: string }[];
    const attempt = (changed: unknown): string => {
      const file = path.join(root, "m.json");
      writeFileSync(file, JSON.stringify(changed));
      try {
        loadManifest(file);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(attempt(entries.slice(1))).toContain("has no darwin-arm64 entry");
    expect(attempt(entries.map((e, i) => (i === 0 ? { ...e, sha256: "abc" } : e)))).toContain("has no SHA-256");
    expect(attempt(entries.map((e, i) => (i === 0 ? { ...e, version: "9.9.9" } : e)))).toContain("one x.y.z version");
    expect(attempt([...entries, entries[0]])).toContain("twice");
    expect(attempt("not a list")).toContain("not a list");
  });
});

describe("the Homebrew formula and the checksums file", () => {
  it("has each platform's url and sha256 from the manifest, and no placeholder", () => {
    const text = renderTemplate(readFileSync(FORMULA, "utf8"), loadManifest(manifestFile)) as string;
    expect(text).not.toContain("@FX_");
    expect(text).toContain('version "1.2.3"');
    // each block names the file of its platform and the hash the manifest computed for exactly that file
    const blocks: [string, string, string][] = [
      ["on_macos", "on_arm", "darwin-arm64"],
      ["on_macos", "on_intel", "darwin-x64"],
      ["on_linux", "on_arm", "linux-arm64"],
      ["on_linux", "on_intel", "linux-x64"],
    ];
    for (const [os, cpu, platform] of blocks) {
      const start = text.indexOf(os);
      const at = text.indexOf(cpu, start);
      const block = text.slice(at, text.indexOf("end", at));
      expect(block).toContain(`/releases/download/v1.2.3/${(ARTIFACT_NAMES as Record<string, string>)[platform]}"`);
      expect(block).toContain(`sha256 "${hashes.get(platform)}"`);
    }
  });

  it("is rendered exactly: the whole file, so a change to the template shows up here", () => {
    const text = renderTemplate(readFileSync(FORMULA, "utf8"), { version: "1.2.3", entries: PLATFORMS.map((platform) => ({ platform, version: "1.2.3", sha256: platform.length.toString(16).padStart(64, "0") })) }) as string;
    expect(text.split("\n").filter((line: string) => /^\s*(url|sha256|version) /.test(line))).toMatchInlineSnapshot(`
      [
        "  version "1.2.3"",
        "      url "https://github.com/fulcrumaxe/fulcrumaxe-cloud/releases/download/v1.2.3/fx-runner-darwin-arm64"",
        "      sha256 "000000000000000000000000000000000000000000000000000000000000000c"",
        "      url "https://github.com/fulcrumaxe/fulcrumaxe-cloud/releases/download/v1.2.3/fx-runner-darwin-x64"",
        "      sha256 "000000000000000000000000000000000000000000000000000000000000000a"",
        "      url "https://github.com/fulcrumaxe/fulcrumaxe-cloud/releases/download/v1.2.3/fx-runner-linux-arm64"",
        "      sha256 "000000000000000000000000000000000000000000000000000000000000000b"",
        "      url "https://github.com/fulcrumaxe/fulcrumaxe-cloud/releases/download/v1.2.3/fx-runner-linux-x64"",
        "      sha256 "0000000000000000000000000000000000000000000000000000000000000009"",
      ]
    `);
  });

  it("writes SHA256SUMS in the format sha256sum -c reads, from the same manifest", () => {
    const out = path.join(root, "SHA256SUMS");
    expect(run("release-render.mjs", ["checksums", "--manifest", manifestFile, "--out", out]).status).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toBe(checksumsText(loadManifest(manifestFile)));
    for (const [platform, name] of Object.entries(ARTIFACT_NAMES)) expect(text).toContain(`${hashes.get(platform)}  ${name}\n`);
  });
});
