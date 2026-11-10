import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIDECAR_ARCHIVE, SIDECAR_DIR, listTree, pinnedVersion, treeDigest, unpackSidecar } from "../../scripts/sidecar.mjs";
import { sdkTraces } from "../helpers/sdkTraces.js";
import { CHROMIUM, startVerifyServer } from "../helpers/verifyServerClient.js";

// The real build, on the machine that runs the tests (D#6 R6-1 acceptance 1, 2 and 3): the real Node release from nodejs.org, the real postject, a real
// executable that is then run. It runs on Linux x64, the platform CI builds; the macOS half (signature removal, ad-hoc signing) runs on R6-5's hosted
// macOS runner. FX_SEA_SKIP_REAL=1 skips it, and it skips by itself when nodejs.org cannot be reached.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "build-sea.mjs");
const REAL = process.platform === "linux" && process.arch === "x64" && process.env.FX_SEA_SKIP_REAL !== "1";
const EPOCH = "1780000000";

/** The build downloads Node from nodejs.org. Where that cannot be reached (an offline runner) the suite skips instead of failing: the build's own checks are covered offline in seaPins and seaTamper. */
async function nodejsReachable(): Promise<boolean> {
  if (!REAL) return false;
  try {
    const response = await fetch("https://nodejs.org/dist/index.json", { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return response.ok;
  } catch {
    return false;
  }
}
const REACHABLE = await nodejsReachable();

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
function exec(file: string, args: readonly string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), FX_FORBID_MODEL_CALLS: "1", ...env }, maxBuffer: 1 << 24 }, (error, stdout, stderr) =>
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr }),
    );
  });
}

describe.skipIf(!REACHABLE)("the Linux x64 single-executable build", () => {
  let root: string;
  let a: string;
  let b: string;
  let c: string;
  let home: string;
  const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
  const file = (dir: string): string => path.join(dir, "fx-runner-linux-x64");

  async function build(outDir: string, epoch: string): Promise<void> {
    const result = await exec(process.execPath, [SCRIPT, "--out-dir", outDir], { SOURCE_DATE_EPOCH: epoch, FX_SEA_NODE_CACHE_DIR: path.join(root, "node-cache") });
    expect(result.stderr.replace(/^warning: .*\n/gm, "")).toBe("");
    expect(result.code).toBe(0);
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "fx-sea-real-"));
    [a, b, c, home] = [path.join(root, "a"), path.join(root, "b"), path.join(root, "c"), path.join(root, "home")];
    mkdirSync(home);
    await build(a, EPOCH);
    await build(b, EPOCH);
    await build(c, "1780000001");
  }, 300_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const runner = (args: string[]): Promise<Run> => exec(file(a), args, { HOME: home, FX_RUNNER_HOME: path.join(home, ".fx-runner") });

  it("runs --version", async () => {
    const result = await runner(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("fx-runner 0.1.1 (2026-05-28)\n");
  });

  it("runs doctor --sandbox-only and answers as the probe does: 0 on a pass, 1 with the failed line on a fail", async () => {
    const result = await runner(["doctor", "--sandbox-only"]);
    const line = result.stdout.split("\n").filter((text) => text.includes("Sandbox:"));
    expect(line).toHaveLength(1);
    if (result.code === 0) expect(line[0]).toMatch(/^PASS /);
    else {
      expect(result.code).toBe(1);
      expect(line[0]).toMatch(/^FAIL .*(bwrap_missing|socat_missing|userns_disabled|apparmor_userns_restricted|probe_failed_other)/);
    }
    expect(result.stdout).not.toContain("Registration");
    expect(result.stderr).toBe("");
  }, 60_000);

  it("runs the rest of the command line: help, a bad command (exit 2), status and logs on an empty machine", async () => {
    expect((await runner(["--help"])).stdout).toContain("Usage: fx-runner");
    const bad = await runner(["nonsense"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown command");
    const status = await runner(["status"]);
    expect(status.stderr + status.stdout).not.toContain("unexpected");
    expect((await runner(["logs", "00000000-0000-4000-8000-000000000000"])).stderr).not.toContain("unexpected");
  });

  it("names itself, not a script, in the service file it writes", async () => {
    const result = await runner(["service", "install"]);
    expect(result.code).toBe(0);
    const unit = readFileSync(path.join(home, ".config", "systemd", "user", "fx-runner.service"), "utf8");
    expect(unit).toContain(`ExecStart=${file(a)} run\n`);
  });

  it("is reproducible: two builds from one commit and one SOURCE_DATE_EPOCH have the same SHA-256, and a different epoch does not", () => {
    expect(sha(file(a))).toBe(sha(file(b)));
    expect(sha(file(c))).not.toBe(sha(file(a)));
  });

  it("writes a manifest with the version, platform, SHA-256 and size of the file, and nothing else", () => {
    const manifest = JSON.parse(readFileSync(path.join(a, "release-manifest.json"), "utf8"));
    // D#749 V2c-2c: the Playwright sidecar archive is one more entry (no platform: the same bytes everywhere).
    expect(manifest).toEqual([
      { version: "0.1.1", platform: "linux-x64", sha256: sha(file(a)), size: readFileSync(file(a)).length },
      { version: "0.1.1", artifact: "playwright-sidecar", sha256: sha(path.join(a, SIDECAR_ARCHIVE)), size: readFileSync(path.join(a, SIDECAR_ARCHIVE)).length },
    ]);
    expect(readFileSync(path.join(a, "release-manifest.json"), "utf8")).toBe(readFileSync(path.join(b, "release-manifest.json"), "utf8"));
  });

  it("carries no Claude Agent SDK path or identifier in the executable or in any release file", () => {
    for (const name of readdirSync(a).filter((entry) => statSync(path.join(a, entry)).isFile())) expect(sdkTraces(readFileSync(path.join(a, name))), name).toEqual([]);
    for (const entry of listTree(path.join(a, SIDECAR_DIR))) expect(sdkTraces(readFileSync(path.join(a, SIDECAR_DIR, entry.path))), entry.path).toEqual([]);
    expect(readdirSync(a).sort()).toEqual(["fx-runner-linux-x64", SIDECAR_DIR, SIDECAR_ARCHIVE, "release-manifest.json"].sort());
  });

  // D#749 V2c-2c: the Playwright sidecar the build lays down beside the binary.
  it("lays the exact pinned playwright-core beside the binary, with no browser in it, and the archive unpacks to the same tree", () => {
    const dir = path.join(a, SIDECAR_DIR);
    expect(readdirSync(dir)).toEqual(["node_modules"]);
    expect(JSON.parse(readFileSync(path.join(dir, "node_modules", "playwright-core", "package.json"), "utf8")).version).toBe(pinnedVersion());
    const tree = listTree(dir);
    expect(tree.some((entry) => /\.local-browsers|chrome-linux|chromium-\d|headless_shell/i.test(entry.path))).toBe(false);
    const unpacked = path.join(root, "unpacked");
    expect(unpackSidecar(readFileSync(path.join(a, SIDECAR_ARCHIVE)), unpacked).digest).toBe(treeDigest(tree));
  });

  it("carries the digest of that folder inside the executable, and two builds lay down the same folder and archive", () => {
    const digest = treeDigest(listTree(path.join(a, SIDECAR_DIR)));
    expect(readFileSync(file(a)).includes(Buffer.from(digest))).toBe(true);
    expect(treeDigest(listTree(path.join(b, SIDECAR_DIR)))).toBe(digest);
    expect(sha(path.join(b, SIDECAR_ARCHIVE))).toBe(sha(path.join(a, SIDECAR_ARCHIVE)));
  });

  it.skipIf(CHROMIUM === undefined)("the real program finds its sidecar and opens a real page; with the folder missing, edited or extended it answers playwright_missing", async () => {
    const run = path.join(root, "run");
    cpSync(a, run, { recursive: true });
    const binary = file(run);
    const open = async (): Promise<{ text: string; isError: boolean }> => {
      const server = await startVerifyServer(binary);
      try {
        return await server.open();
      } finally {
        await server.close();
      }
    };
    expect(await open()).toMatchObject({ isError: false, text: expect.stringContaining("opened") });
    const lib = path.join(run, SIDECAR_DIR, "node_modules", "playwright-core");
    writeFileSync(path.join(lib, "added.js"), "x");
    expect(await open()).toEqual({ isError: true, text: expect.stringContaining("playwright_missing") });
    rmSync(path.join(lib, "added.js"));
    const index = readFileSync(path.join(lib, "index.js"), "utf8");
    writeFileSync(path.join(lib, "index.js"), `${index}\n`);
    expect(await open()).toEqual({ isError: true, text: expect.stringContaining("playwright_missing") });
    writeFileSync(path.join(lib, "index.js"), index);
    expect(await open()).toMatchObject({ isError: false });
    rmSync(path.join(run, SIDECAR_DIR), { recursive: true });
    expect(existsSync(path.join(run, SIDECAR_DIR))).toBe(false);
    expect(await open()).toEqual({ isError: true, text: expect.stringContaining("playwright_missing") });
  }, 180_000);

  it("a build that fails while putting its files in place writes nothing: the old binary, sidecar folder and archive are exactly as they were", async () => {
    const out = path.join(root, "failed-out");
    cpSync(a, out, { recursive: true });
    // The archive's place holds a folder, so writing the new archive fails AFTER the new sidecar folder was swapped in.
    rmSync(path.join(out, SIDECAR_ARCHIVE));
    mkdirSync(path.join(out, SIDECAR_ARCHIVE));
    writeFileSync(path.join(out, SIDECAR_ARCHIVE, "keep"), "x");
    const snapshot = (): string =>
      JSON.stringify([sha(file(out)), treeDigest(listTree(path.join(out, SIDECAR_DIR))), statSync(path.join(out, SIDECAR_DIR, "node_modules", "playwright-core", "package.json")).mtime.getTime() / 1000 | 0, statSync(file(out)).mtime.getTime() / 1000 | 0, readdirSync(out).sort(), readdirSync(path.join(out, SIDECAR_ARCHIVE))]);
    const before = snapshot();
    const result = await exec(process.execPath, [SCRIPT, "--out-dir", out], { SOURCE_DATE_EPOCH: "1780000002", FX_SEA_NODE_CACHE_DIR: path.join(root, "node-cache") });
    expect(result.code).not.toBe(0);
    expect(snapshot()).toBe(before);
  }, 120_000);

  it.skipIf(CHROMIUM === undefined)("code planted outside the sidecar (a parent node_modules, NODE_PATH, ~/.node_modules) never runs in the real program, which still opens a real page", async () => {
    const holder = path.join(root, "fence");
    const run = path.join(holder, "run");
    mkdirSync(holder, { recursive: true });
    cpSync(a, run, { recursive: true });
    const marks = path.join(holder, "marks");
    mkdirSync(marks);
    const plant = (nodeModules: string, tag: string): void => {
      // The addons playwright-core's bundled ws asks for, and two more names, so the plant does not rely on the library's own list.
      for (const name of ["bufferutil", "utf-8-validate", "ws", "playwright-core"]) {
        mkdirSync(path.join(nodeModules, name), { recursive: true });
        writeFileSync(path.join(nodeModules, name, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
        writeFileSync(path.join(nodeModules, name, "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(path.join(marks, `${tag}-${name}`))}, "ran");\nmodule.exports = {};\n`);
      }
    };
    const fakeHome = path.join(holder, "home");
    plant(path.join(holder, "node_modules"), "parent");
    plant(path.join(holder, "np", "node_modules"), "nodepath");
    plant(path.join(fakeHome, ".node_modules"), "home");
    const server = await startVerifyServer(file(run), { HOME: fakeHome, NODE_PATH: path.join(holder, "np", "node_modules") });
    try {
      expect(await server.open()).toMatchObject({ isError: false, text: expect.stringContaining("opened") });
    } finally {
      await server.close();
    }
    expect(readdirSync(marks)).toEqual([]);
  }, 180_000);
});
