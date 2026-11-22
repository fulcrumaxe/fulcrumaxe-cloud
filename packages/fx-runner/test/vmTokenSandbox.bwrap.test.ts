import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VM_TOKEN_DIR, VM_TOKEN_FILE, writeVmToken } from "../src/credentials/vmToken.js";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { SHARED_TEMP_DIRS, sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * D#587 B-6-VMTOKEN: a REAL read attempt under the OS sandbox. The token file lives in the state directory, which every OS-sandbox job is denied; the rules come
 * from the one builder (`sandboxSettings`), are translated by the probe's own translation (`bwrapArgs`, the code `doctor` runs), and commands run for real inside them.
 * With the settings built the way a job's are, the file must be unreadable, unlistable and unreplaceable from inside, while the same file is readable from outside
 * (so the denial is the sandbox's, not a missing or mis-moded file). Skipped, with the reason printed, on a host where bubblewrap cannot create namespaces (or inside a runner job).
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
// The state directory has to sit where ONLY its own rule protects it: not under a shared temp directory (denied wholesale) and not under the home directory the settings are built with
// (a fake one). The directory this suite runs in is that place; when it is itself under a shared temp directory, the test cannot prove the state-directory rule and skips, saying so.
const BASE = process.cwd();
const BASE_IN_SHARED_TEMP = SHARED_TEMP_DIRS.some((dir) => BASE === dir || BASE.startsWith(`${dir}${path.sep}`));
const usable = BWRAP !== undefined && !BASE_IN_SHARED_TEMP && bwrapCanCreateNamespaces(BWRAP);
if (!usable) console.info(`[skip] vmTokenSandbox.bwrap: ${BASE_IN_SHARED_TEMP ? "the working directory is under a shared temp directory, which hides the state directory by itself" : "no usable bubblewrap here (missing, no user namespaces, or running inside a runner job)"}; the sandbox read denial is proved where it can run`);

// Assembled from fragments so no token-shaped literal sits in the source.
const TOKEN = ["sk-ant-", "oat01-", "SANDBOXFAKE0123456789abcd"].join("");
let root: string;
let outside: string;
let home: string;
let stateDir: string;
let workspace: string;
let tempDir: string;
let settings: Record<string, unknown>;

function inSandbox(script: string): { code: number | null; stdout: string; stderr: string } {
  const args = [...bwrapArgs(settings, (target) => existsSync(target) && statSync(target).isDirectory(), (target) => existsSync(target) && statSync(target).isFile()), "--", "/bin/sh", "-c", script];
  const out = spawnSync(BWRAP!, args, { env: { PATH: "/run/current-system/sw/bin:/usr/bin:/bin", HOME: home }, encoding: "utf8", timeout: 20_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

describe.skipIf(!usable)("the VM token file under a real OS sandbox", () => {
  const tokenFile = (): string => path.join(stateDir, VM_TOKEN_DIR, VM_TOKEN_FILE);
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpRoot(), "vmtok-bwrap-"));
    home = path.join(root, "home");
    // A custom FX_RUNNER_HOME outside the home directory and the shared temp directories, so only the state-directory rule protects the file.
    outside = mkdtempSync(path.join(BASE, ".vmtok-sandbox-"));
    stateDir = path.join(outside, "state");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    tempDir = path.join(home, ".cache", "fx-runner", "tmp", "rn-1");
    for (const dir of [workspace, tempDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(workspace, "readable.txt"), "workspace-data");
    writeVmToken(stateDir, process.getuid?.(), TOKEN);
    settings = sandboxSettings({
      workspace, tempDir, home, stateDir, binaryDir: path.join(root, "bin"),
      workspaceRoot: path.dirname(workspace), tempRoot: path.dirname(tempDir),
    });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("control: the file is there and readable by this user outside the sandbox, and the sandbox itself runs and reads the workspace", () => {
    expect(readFileSync(tokenFile(), "utf8")).toBe(TOKEN);
    expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(inSandbox(`cat ${workspace}/readable.txt`).stdout.trim()).toBe("workspace-data");
  });

  it("a job cannot read the token file: the command fails and no part of the token comes out", () => {
    const read = inSandbox(`cat ${tokenFile()}`);
    expect(read.code).not.toBe(0);
    expect(read.stdout).not.toContain("SANDBOXFAKE");
    expect(read.stdout).not.toContain("sk-ant");
    expect(read.stderr).not.toContain("SANDBOXFAKE");
  });

  it("a job cannot list the credentials directory, find the file by name, or read it through the shell's redirection", () => {
    const listed = inSandbox(`ls ${path.join(stateDir, VM_TOKEN_DIR)}`);
    expect(listed.stdout).not.toContain(VM_TOKEN_FILE);
    const redirected = inSandbox(`read -r line < ${tokenFile()} && echo "$line"`);
    expect(redirected.stdout).not.toContain("sk-ant");
    const viaNode = inSandbox(`${process.execPath} -e 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))' ${tokenFile()}`);
    expect(viaNode.stdout).not.toContain("sk-ant");
  });

  it("a job cannot replace or remove the file either, and the file is untouched afterwards", () => {
    expect(inSandbox(`echo replaced > ${tokenFile()}`).code).not.toBe(0);
    expect(inSandbox(`rm -f ${tokenFile()}`).stdout).toBe("");
    expect(readFileSync(tokenFile(), "utf8")).toBe(TOKEN);
  });
});
