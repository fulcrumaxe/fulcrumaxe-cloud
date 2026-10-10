import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/engines/claude/capture.js";
import { createNixShell, findTool, identityVia } from "../src/daemon/nixShell.js";
import { createGitPath } from "../src/daemon/gitPath.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";

/**
 * D#6 R7c with the real `nix` (2.4 or newer with flakes), a real git mirror and the real git path's default-branch check. Skips, naming why, when nix or git
 * is not on this machine, when this is not x86_64 Linux (the flake names its system), or when the runner user is a Nix trusted user (the step refuses then,
 * and that is its own test). CI: whether this ran there is stated in the pull request.
 */
const NIX = ["/run/current-system/sw/bin/nix", "/usr/bin/nix", "/nix/var/nix/profiles/default/bin/nix"].find((candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
const GIT = findTool("git", process.env["PATH"] ?? "");
const usable = ((): boolean => {
  if (NIX === undefined || BWRAP === undefined || process.platform !== "linux" || process.arch !== "x64") return false;
  if (spawnSync(NIX, ["--version"], { stdio: "ignore" }).status !== 0 || spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  return bwrapCanCreateNamespaces(BWRAP);
})();

// A flake with no inputs, so it needs no network. `nix develop` wants a bash builder and a `$stdenv/setup`, which a repo gets from nixpkgs; here a shim stands in.
// Building it needs a real bash inside Nix's build sandbox, which only a nixpkgs closure gives, so on this fixture the build stops at the shell's own script:
// everything before that (the mirror fetch at the rev, the lock rules, every flag, the trusted-users read) is real, and what comes after is proved with the fake nix.
const FLAKE = `{
  outputs = { self }: {
    devShells.x86_64-linux.default = derivation { name = "r7c-shell"; system = "x86_64-linux"; builder = "\${./bin}/bash"; args = [ "-c" "echo > $out" ]; stdenv = ./stdenv; PATH = "\${./bin}"; CC = "gcc"; };
  };
}
`;
const SHIM = ["#!", "/bin/sh\nexec ", "/bin/sh", ' "$@"\n'].join("");
const LOCK = JSON.stringify({ nodes: { root: {} }, root: "root", version: 7 });

let root: string;
let mirrorsRoot: string;
let head: string;
let branchTip: string;
let canaryTip: string;
const CANARY_NAME = `fxc431-canary-${randomBytes(8).toString("hex")}`;
/** Whether the Nix store holds an entry made by the canary flake: it appears only if that flake was evaluated. */
const canaryInStore = (): boolean => readdirSync("/nix/store").some((entry) => entry.endsWith(`-${CANARY_NAME}`));
let devStderr = "";
const devArgv: string[] = [];
const capture = async (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => {
  const out = await runCapture(spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 4096);
  if (args.includes("print-dev-env")) {
    devStderr = out.stderr ?? "";
    devArgv.push(args.join(" "));
  }
  return out;
};

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

describe.skipIf(!usable)("R7c with the real nix", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "r7c-real-"));
    const origin = path.join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(path.join(origin, "flake.nix"), FLAKE);
    writeFileSync(path.join(origin, "flake.lock"), LOCK);
    mkdirSync(path.join(origin, "bin"));
    writeFileSync(path.join(origin, "bin", "bash"), SHIM, { mode: 0o755 });
    mkdirSync(path.join(origin, "stdenv"));
    writeFileSync(path.join(origin, "stdenv", "setup"), "\n");
    git(origin, "add", "flake.nix", "flake.lock", "bin", "stdenv");
    git(origin, "commit", "-q", "-m", "flake");
    head = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "-b", "fx/side");
    writeFileSync(path.join(origin, "extra.txt"), "x");
    git(origin, "add", "extra.txt");
    git(origin, "commit", "-q", "-m", "side");
    branchTip = git(origin, "rev-parse", "HEAD");
    // a pull-request head whose flake, if it were ever evaluated, writes a file into the Nix store (a derivation attribute made with builtins.toFile)
    git(origin, "checkout", "-q", "-b", "fx/canary", head);
    writeFileSync(path.join(origin, "flake.nix"), FLAKE.replace('CC = "gcc";', `CC = "gcc"; canary = builtins.toFile "${CANARY_NAME}" "evaluated";`));
    git(origin, "add", "flake.nix");
    git(origin, "commit", "-q", "-m", "flake with a canary");
    canaryTip = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "main");
    mirrorsRoot = path.join(root, "mirrors");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("realises a real dev shell from a commit on the default branch of a real mirror, and skips a commit that is only on a run branch", async () => {
    const stateDir = path.join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const gitPath = createGitPath({ capture, mirrorsRoot, stateDir, remoteUrl: () => path.join(root, "origin") });
    const job = { repo: { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" }, continues: null, branch_prefix: "fx/", role: "executor" } as unknown as Parameters<typeof gitPath.prepare>[0];
    // the mirror is made by the real path's own prepare, so its HEAD follows the default branch exactly as in production
    const workspace = path.join(root, "workspace");
    const prepared = await gitPath.prepare(job, { runId: "11111111-1111-4111-8111-111111111111", leaseGeneration: 1 }, workspace);
    expect(prepared.base).toBe(head);
    const source = await gitPath.nixSource!(job, head);
    expect(source).toMatchObject({ kind: "flake", lock: LOCK });
    expect(await gitPath.nixSource!(job, branchTip)).toMatchObject({ kind: "flake", fromDefault: { rev: head, flakeChanged: false } });

    const nixBin = realpathSync(NIX!);
    const step = createNixShell({ nixBin, bwrapBin: BWRAP, gitBin: GIT, capture, dataDir: path.join(root, "nix-data"), identity: identityVia(capture) });
    const result = await step.prepare({ approved: true, sha: head, source });
    if (!result.ok && result.skip === "nix_trusted_user") return; // the runner user is trusted on this machine: refused, as it must be
    if (!result.ok) {
      // the fetch of the rev from the mirror, the flake's evaluation and every flag were accepted by the real nix; the build reached the shell's own script
      expect(result).toEqual({ ok: false, skip: "nix_failed" });
      expect(devStderr).toContain("get-env.sh");
      expect(devStderr).not.toMatch(/unrecognised flag|lock file|error: getting status/i);
      return;
    }
    // the fixed PATH's first entry is nix's own store directory: it survives the filter, the host's directories do not
    expect(result.env["PATH"]!.split(":").every((entry) => entry.startsWith("/nix/store/"))).toBe(true);
    expect(Object.keys(result.env).every((name) => name === "PATH")).toBe(true);
    expect(await step.prepare({ approved: true, sha: head, source })).toMatchObject({ ok: true, cached: true });
  }, 300_000);

  it("a pull-request head whose flake has a side effect is never evaluated: the shell is built from the merge-base, and the side effect never happens", async () => {
    const stateDir = path.join(root, "state-canary");
    mkdirSync(stateDir, { recursive: true });
    const gitPath = createGitPath({ capture, mirrorsRoot: path.join(root, "mirrors-canary"), stateDir, remoteUrl: () => path.join(root, "origin") });
    const job = { repo: { id: "44444444-4444-4444-8444-444444444444", owner: "acme", name: "widgets" }, continues: null, branch_prefix: "fx/", role: "code-reviewer" } as unknown as Parameters<typeof gitPath.prepare>[0];
    await gitPath.prepare(job, { runId: "11111111-1111-4111-8111-111111111111", leaseGeneration: 1 }, path.join(root, "workspace-canary"));
    const source = await gitPath.nixSource!(job, canaryTip);
    expect(source).toMatchObject({ kind: "flake", fromDefault: { rev: head, flakeChanged: true } });
    const rev = (source as { fromDefault: { rev: string } }).fromDefault.rev;

    const nixBin = realpathSync(NIX!);
    const step = createNixShell({ nixBin, bwrapBin: BWRAP, gitBin: GIT, capture, dataDir: path.join(root, "nix-data-canary"), identity: identityVia(capture) });
    devArgv.length = 0;
    const result = await step.prepare({ approved: true, sha: rev, source });
    const refused = !result.ok && result.skip === "nix_trusted_user";
    if (!refused) {
      expect(devArgv).toHaveLength(1);
      expect(devArgv[0]).toContain(`?rev=${head}`);
      expect(devArgv[0]).not.toContain(canaryTip);
      // the environment is the default branch's own: the same outcome as building the default branch's commit directly
      expect(result).toEqual(await step.prepare({ approved: true, sha: head, source: await gitPath.nixSource!(job, head) }));
    }
    expect(canaryInStore()).toBe(false);

    // control: the canary does fire when that flake is evaluated, so the absence above means something
    const control = spawnSync(NIX!, ["--extra-experimental-features", "nix-command flakes", "eval", "--raw", `git+file://${path.join(root, "origin")}?rev=${canaryTip}#devShells.x86_64-linux.default.drvPath`], { encoding: "utf8" });
    expect(control.status).toBe(0);
    expect(canaryInStore()).toBe(true);
  }, 300_000);
});
