import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/engines/claude/capture.js";
import { createNixShell, findTool, identityVia, NIX_FIXED_ARGS } from "../src/daemon/nixShell.js";

/**
 * D#6 R7c fix round 1 (CWE-15), with the real `nix`: a host nix.conf that turns the dangerous settings on, and flakes that try to use them. The step's fixed
 * environment carries no NIX_CONF_DIR, so the capture below adds it: that stands for a host-wide /etc/nix/nix.conf. The flags in NIX_FIXED_ARGS must beat the
 * conf. Skips cleanly when nix or git is not on this machine or this is not x86_64 Linux (the flakes name their system).
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
  return spawnSync(NIX, ["--version"], { stdio: "ignore" }).status === 0 && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
})();

const LOCK = JSON.stringify({ nodes: { root: {} }, root: "root", version: 7 });

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

// builtins.exec runs a command during evaluation, as the runner user, outside every sandbox: the marker file shows whether it ran.
const execFlake = (file: string) => `{
  outputs = { self }: let ran = builtins.exec [ "/bin/sh" "-c" "echo ran > ${file}; echo '\\"x\\"'" ]; in {
    devShells.x86_64-linux.default = derivation { name = "r7c-exec"; system = "x86_64-linux"; builder = "/bin/sh"; args = [ "-c" "true" ]; marker = ran; };
  };
}
`;
// nixConfig asks to switch import from derivation back on, then imports a derivation's output while evaluating.
const IFD_FLAKE = `{
  nixConfig.allow-import-from-derivation = true;
  outputs = { self }: let d = derivation { name = "r7c-ifd"; system = "x86_64-linux"; builder = "/bin/sh"; args = [ "-c" "echo '\\"x\\"' > $out" ]; }; in {
    devShells.x86_64-linux.default = derivation { name = "r7c-ifd-shell"; system = "x86_64-linux"; builder = "/bin/sh"; args = [ "-c" "true" ]; imported = import d; };
  };
}
`;

describe.skipIf(!usable)("R7c: the host's nix.conf cannot re-enable what the step turns off (real nix)", () => {
  let base: string;
  let confDir: string;
  let marker: string;
  let origin: string;
  let execSha: string;
  let ifdSha: string;
  let stderr = "";

  const withConf = async (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => {
    const out = await runCapture(spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 8192);
    if (args.includes("print-dev-env")) stderr = out.stderr ?? "";
    return out;
  };
  const nixBin = () => realpathSync(NIX!);
  const refFor = (rev: string) => `git+file://${origin}?rev=${rev}`;
  // the same command the step runs, with the old flags only (no accept-flake-config / native-code options)
  const withOldFlags = (rev: string) =>
    spawnSync(nixBin(), ["--extra-experimental-features", "nix-command flakes", "print-dev-env", "--json", "--no-write-lock-file", "--no-update-lock-file", "--option", "allow-import-from-derivation", "false", refFor(rev)], {
      env: { PATH: `${path.dirname(nixBin())}:/usr/bin:/bin`, HOME: path.join(base, "home"), TMPDIR: base, LANG: "C", NIX_CONF_DIR: confDir },
      encoding: "utf8",
      timeout: 120_000,
    });

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), "r7c-conf-"));
    confDir = path.join(base, "conf");
    mkdirSync(confDir);
    mkdirSync(path.join(base, "home"));
    writeFileSync(path.join(confDir, "nix.conf"), "accept-flake-config = true\nallow-unsafe-native-code-during-evaluation = true\nextra-experimental-features = nix-command flakes\n");
    marker = path.join(base, "exec-ran");
    origin = path.join(base, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(path.join(origin, "flake.lock"), LOCK);
    writeFileSync(path.join(origin, "flake.nix"), execFlake(marker));
    git(origin, "add", "flake.nix", "flake.lock");
    git(origin, "commit", "-q", "-m", "exec");
    execSha = git(origin, "rev-parse", "HEAD");
    writeFileSync(path.join(origin, "flake.nix"), IFD_FLAKE);
    git(origin, "add", "flake.nix");
    git(origin, "commit", "-q", "-m", "ifd");
    ifdSha = git(origin, "rev-parse", "HEAD");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("control: with only the old flags, the permissive host conf lets builtins.exec run a command as the runner user", () => {
    withOldFlags(execSha);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  }, 150_000);

  it("control: with only the old flags, the permissive host conf lets the flake's nixConfig re-enable import from derivation", () => {
    expect(withOldFlags(ifdSha).stderr).not.toMatch(/import.from.derivation|allow-import-from-derivation/i);
  }, 150_000);

  it("with the step's flags, builtins.exec is refused: the command never runs", async () => {
    expect(NIX_FIXED_ARGS.join(" ")).toContain("--option allow-unsafe-native-code-during-evaluation false");
    const step = createNixShell({ nixBin: nixBin(), bwrapBin: BWRAP, gitBin: GIT, etcNixDir: confDir, capture: withConf, dataDir: path.join(base, "data-exec"), identity: identityVia(withConf) });
    const result = await step.prepare({ approved: true, sha: execSha, source: { kind: "flake", mirrorDir: origin, lock: LOCK } });
    if (!result.ok && result.skip === "nix_trusted_user") return; // the runner user is trusted on this machine: refused earlier, as it must be
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(existsSync(marker)).toBe(false);
    // the marker alone proves little (the view has its own empty /tmp): the refusal is read off nix's own message
    expect(stderr).toMatch(/attribute 'exec' missing/);
  }, 150_000);

  it("with the step's flags, a flake's nixConfig cannot switch import from derivation back on", async () => {
    const step = createNixShell({ nixBin: nixBin(), bwrapBin: BWRAP, gitBin: GIT, etcNixDir: confDir, capture: withConf, dataDir: path.join(base, "data-ifd"), identity: identityVia(withConf) });
    const result = await step.prepare({ approved: true, sha: ifdSha, source: { kind: "flake", mirrorDir: origin, lock: LOCK } });
    if (!result.ok && result.skip === "nix_trusted_user") return;
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(stderr).toMatch(/import.from.derivation|allow-import-from-derivation/i);
  }, 150_000);
});
