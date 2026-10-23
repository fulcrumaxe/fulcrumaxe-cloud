/**
 * D#6 RUNNER-CWD-1, with real bubblewrap (skipped without it, or inside a runner job). Two things:
 *  - `doctor`'s sandbox probe arguments (`bwrapArgs` of `probeSettings`, the plain probe and the job-shell probe's form that covers denied files)
 *    leave the host tree exactly as it was: bubblewrap makes a mount point on the host when it binds onto a path that does not exist inside a
 *    writable bind, and the probe must never ask it to;
 *  - a job's sandbox denies reads of the shared temp directories: another session's file under the temp directory is unreadable, while the job's
 *    own temp directory and workspace stay readable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheRootsFor } from "../../src/daemon/mirror.js";
import { bwrapArgs, probeSettings } from "../../src/sandbox/probe.js";
import { sandboxSettings } from "../../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "../helpers/bwrapProbe.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = process.platform === "linux" && BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);
const PATH_ENV = "/run/current-system/sw/bin:/usr/bin:/bin";
const CANARY = "FX-CWD1-CANARY-6d1f0b3c2a9e4b7f";

/** Every entry under `dir` with its kind, size and mode: a host change of any of them shows. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = path.join(rel, name);
      const info = lstatSync(path.join(dir, child));
      out.push(`${child} ${info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : "f"} ${info.isDirectory() ? 0 : info.size} ${(info.mode & 0o7777).toString(8)}`);
      if (info.isDirectory()) walk(child);
    }
  };
  walk("");
  return out;
}

const isDir = (target: string): boolean => existsSync(target) && statSync(target).isDirectory();
const isFile = (target: string): boolean => existsSync(target) && statSync(target).isFile();

describe.skipIf(!usable)("RUNNER-CWD-1: the sandbox probe in real bubblewrap", () => {
  let base: string;
  let home: string;
  beforeAll(() => {
    base = mkdtempSync(path.join(tmpRoot(), "cwd1-probe-"));
    home = path.join(base, "home");
    // Some protected names exist and some do not, so a bind onto a missing one would show as a new host entry.
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    writeFileSync(path.join(home, ".ssh", "id_ed25519"), CANARY);
    writeFileSync(path.join(home, ".bashrc"), "export X=1\n");
    mkdirSync(path.join(home, ".cache", "fx-runner", "workspaces"), { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("the plain probe and the job-shell probe's covered form change nothing on the host", () => {
    const settings = probeSettings({ platform: "linux", home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(base, "bin") });
    const before = snapshot(base);
    for (const args of [bwrapArgs(settings, isDir), bwrapArgs(settings, isDir, isFile, true)]) {
      const out = spawnSync(BWRAP!, [...args, "--", "/bin/sh", "-c", "printf fx-sandbox-ok"], { env: { PATH: PATH_ENV }, encoding: "utf8", timeout: 20_000 });
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toBe("fx-sandbox-ok");
      expect(snapshot(base)).toEqual(before);
    }
  });
});

describe.skipIf(!usable)("RUNNER-CWD-1: a job cannot read another path under the shared temp directory", () => {
  let base: string;
  let other: string;
  let block: Record<string, unknown>;
  let own: { workspace: string; tempDir: string };
  beforeAll(() => {
    // Another session's scratch file in the temp directory, outside every runner root.
    base = mkdtempSync(path.join(tmpRoot(), "cwd1-tmp-"));
    other = path.join(base, "other-session", "notes.txt");
    mkdirSync(path.dirname(other), { recursive: true });
    writeFileSync(other, CANARY);
    // The job's own directories sit under the runner's cache directory, here inside a home directory of its own (not under the temp directory).
    const home = mkdtempSync(path.join(base, "home-"));
    const roots = cacheRootsFor({ home, platform: "linux" });
    own = { workspace: path.join(roots.workspaceRoot, "run-1"), tempDir: path.join(roots.tempRoot, "rn-1") };
    for (const dir of Object.values(own)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(own.workspace, "mine"), "own-workspace");
    writeFileSync(path.join(own.tempDir, "mine"), "own-temp");
    block = sandboxSettings({ ...own, home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(base, "bin"), workspaceRoot: roots.workspaceRoot, tempRoot: roots.tempRoot });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const run = (settings: Record<string, unknown>, script: string): { code: number | null; stdout: string } => {
    const out = spawnSync(BWRAP!, [...bwrapArgs(settings, isDir, isFile), "--", "/bin/sh", "-c", script], { env: { PATH: PATH_ENV }, encoding: "utf8", timeout: 20_000 });
    return { code: out.status, stdout: out.stdout };
  };

  it("control: with the shared temp directories taken out of denyRead, the other session's file IS readable", () => {
    const fs = block.filesystem as { denyRead: string[] };
    const weakened = { ...block, filesystem: { ...fs, denyRead: fs.denyRead.filter((entry) => !["/tmp", "/var/tmp", "/dev/shm"].includes(entry) && !entry.startsWith("/private/")) } };
    expect(run(weakened, `cat ${other}`).stdout).toContain(CANARY);
  });

  it("the other session's file and its directory listing are not readable from the job", () => {
    const out = run(block, `cat ${other}`);
    expect(out.code).not.toBe(0);
    expect(out.stdout).not.toContain(CANARY);
    expect(run(block, `ls -A ${base} 2>&1`).stdout).not.toContain("other-session");
    // Only the way down to the job's own re-allowed directories shows under the temp directory (here this test's base sits there); nothing else.
    for (const dir of ["/var/tmp", "/dev/shm"]) expect(run(block, `ls -A ${dir}`).stdout.trim(), dir).toBe("");
    expect(run(block, `ls -A ${base}`).stdout.trim().split("\n")).toEqual([path.basename(path.dirname(path.dirname(path.dirname(path.dirname(own.workspace)))))]);
  });

  it("the job's own workspace and temp directory stay readable and writable", () => {
    expect(run(block, `cat ${own.workspace}/mine ${own.tempDir}/mine`).stdout).toBe("own-workspaceown-temp");
    expect(run(block, `echo more > ${own.tempDir}/new && cat ${own.tempDir}/new`).stdout.trim()).toBe("more");
  });
});
