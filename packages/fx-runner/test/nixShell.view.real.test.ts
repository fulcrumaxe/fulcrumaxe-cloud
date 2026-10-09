import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, existsSync as exists, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/engines/claude/capture.js";
import { createNixShell, findTool, identityVia, NIX_FIXED_ARGS } from "../src/daemon/nixShell.js";
import { buildNixView, viewedArgv, type NixViewFs } from "../src/sandbox/nixView.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";

/**
 * D#6 R7c fix round 2 (CWE-552 / CWE-200), with the real `nix`, the real `bwrap` and the real daemon. The Nix client reads files as the runner user, so a
 * flake can make it copy a host file into the world-readable store in two ways the lock check cannot see: `builtins.fetchTree { type = "path"; ... }` at
 * evaluation, and an input declared in `flake.nix` but missing from the lock (locked on the fly despite `--no-update-lock-file`). Each route has a control
 * (nix run the old way, the marker's store path appears) and the fixed step (the same flake through `prepare`, the path never appears). The marker is unique to
 * each run and each store path a control makes is deleted. The marker of the "home" route sits under the runner's own home directory, the kind of place the
 * view must not show. Skips cleanly without nix, bwrap, git or x86_64 Linux.
 */
const firstExisting = (list: string[]): string | undefined =>
  list.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const NIX = firstExisting(["/run/current-system/sw/bin/nix", "/usr/bin/nix", "/nix/var/nix/profiles/default/bin/nix"]);
const BWRAP = firstExisting(["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"]);
const GIT = findTool("git", process.env["PATH"] ?? "");
const usable = ((): boolean => {
  if (NIX === undefined || BWRAP === undefined || process.platform !== "linux" || process.arch !== "x64") return false;
  if (!existsSync("/nix/var/nix/daemon-socket/socket")) return false;
  if (spawnSync(NIX, ["--version"], { stdio: "ignore" }).status !== 0 || spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  return bwrapCanCreateNamespaces(BWRAP);
})();

const LOCK = JSON.stringify({ nodes: { root: {} }, root: "root", version: 7 });
const WRONG_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FEATURES = ["--extra-experimental-features", "nix-command flakes"];
const realFs: NixViewFs = {
  exists: (target) => exists(target),
  isDir: (target) => exists(target) && statSync(target).isDirectory(),
  isFile: (target) => exists(target) && statSync(target).isFile(),
  list: (target) => (exists(target) ? readdirSync(target) : []),
};

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const shell = (extra: string) => `derivation { name = "r7c-view"; system = "x86_64-linux"; builder = "/bin/sh"; args = [ "-c" "true" ]; ${extra} }`;
/** Route (a): a fetch during evaluation, of a directory the flake names, with a hash that cannot match. */
const routeA = (dir: string) => `{
  outputs = { self }: let src = builtins.fetchTree { type = "path"; path = "${dir}"; narHash = "${WRONG_HASH}"; }; in {
    devShells.x86_64-linux.default = ${shell("inherit src;")};
  };
}
`;
/** Route (b): an input the flake declares and the lock does not list. */
const routeB = (dir: string) => `{
  inputs.s = { url = "path:${dir}"; flake = false; };
  outputs = { self, s }: { devShells.x86_64-linux.default = ${shell("")}; };
}
`;

describe.skipIf(!usable)("R7c fix round 2: the nix client sees only an allowlist (real nix, real bwrap)", () => {
  let base: string;
  let homeBase: string;
  const made: string[] = [];
  const nixBin = () => realpathSync(NIX!);
  let lastStderr = "";
  const capture = async (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => {
    const out = await runCapture(spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 8192);
    if (args.includes("print-dev-env")) lastStderr = out.stderr ?? "";
    return out;
  };

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), "r7c-view-"));
    homeBase = mkdtempSync(path.join(homedir(), ".r7c-view-"));
  });
  afterAll(() => {
    for (const entry of made) spawnSync(nixBin(), [...FEATURES, "store", "delete", entry], { stdio: "ignore" });
    rmSync(base, { recursive: true, force: true });
    rmSync(homeBase, { recursive: true, force: true });
  });

  /** A git origin holding `flake.nix` and a lock, plus a unique marker directory under `parent` (or inside the origin when `inside`). */
  function setup(parent: string, flakeFor: (dir: string) => string, lock = LOCK, inside = false) {
    const origin = mkdtempSync(path.join(base, "origin-"));
    const markerDir = inside ? path.join(origin, "visible") : mkdtempSync(path.join(parent, "marker-"));
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(path.join(markerDir, "secret.txt"), `r7c-marker-${randomUUID()}\n`);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(path.join(origin, "flake.nix"), flakeFor(markerDir));
    writeFileSync(path.join(origin, "flake.lock"), lock);
    git(origin, "add", "flake.nix", "flake.lock");
    git(origin, "commit", "-q", "-m", "flake");
    const rev = git(origin, "rev-parse", "HEAD");
    // the path nix gives a copy of the marker directory: computed, not guessed
    const dry = spawnSync(nixBin(), [...FEATURES, "store", "add", "--dry-run", "--mode", "nar", "--name", "source", markerDir], { encoding: "utf8" });
    const storePath = dry.stdout.trim();
    expect(storePath).toMatch(/^\/nix\/store\/[0-9a-z]{32}-source$/);
    expect(existsSync(storePath)).toBe(false);
    made.push(storePath);
    return { origin, rev, storePath };
  }

  const ref = (origin: string, rev: string) => `git+file://${origin}?rev=${rev}`;
  const directEnv = () => ({ PATH: `${path.dirname(nixBin())}:/usr/bin:/bin`, HOME: mkdtempSync(path.join(base, "h-")), TMPDIR: base, LANG: "C" });
  /** The step's flags before restrict-eval was added: what every control below uses. */
  const withoutRestrictEval = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < NIX_FIXED_ARGS.length; i += 1) {
      if (NIX_FIXED_ARGS[i] === "--option" && NIX_FIXED_ARGS[i + 1] === "restrict-eval") {
        i += 2;
        continue;
      }
      out.push(NIX_FIXED_ARGS[i]!);
    }
    return out;
  };

  /** Control: the old run, nix direct as the runner user with no view and no restrict-eval. */
  const runDirect = (origin: string, rev: string) => spawnSync(nixBin(), [...FEATURES, "print-dev-env", "--json", ...withoutRestrictEval(), ref(origin, rev)], { env: directEnv(), encoding: "utf8", timeout: 120_000 });
  /** Control for the second layer: inside the view, with only the options the step had before restrict-eval. */
  const runViewedOld = (origin: string, rev: string) => {
    const view = buildNixView({ nixBin: nixBin(), mirrorDir: origin, ...(GIT === undefined ? {} : { gitBin: realpathSync(GIT) }) }, realFs);
    expect(view).toBeDefined();
    return spawnSync(BWRAP!, viewedArgv(view!, nixBin(), [...FEATURES, "print-dev-env", "--json", ...withoutRestrictEval(), ref(origin, rev)]), { encoding: "utf8", timeout: 120_000 });
  };
  const step = (dataName: string) => createNixShell({ nixBin: nixBin(), bwrapBin: BWRAP, gitBin: GIT, capture, dataDir: path.join(base, dataName), identity: identityVia(capture) });
  const runStep = async (name: string, origin: string, rev: string, lock = LOCK) => step(name).prepare({ approved: true, sha: rev, source: { kind: "flake", mirrorDir: origin, lock } });

  it("route (a), a fetchTree at evaluation: control copies the marker directory into the store; the step does not", async () => {
    const a = setup(base, routeA);
    runDirect(a.origin, a.rev);
    expect(existsSync(a.storePath)).toBe(true); // control: the leak is real without the view
    spawnSync(nixBin(), [...FEATURES, "store", "delete", a.storePath], { stdio: "ignore" });
    expect(existsSync(a.storePath)).toBe(false);

    const result = await runStep("data-a", a.origin, a.rev);
    if (!result.ok && result.skip === "nix_trusted_user") return;
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(lastStderr).toMatch(/forbidden in restricted mode/); // restrict-eval refuses the fetch first
    expect(existsSync(a.storePath)).toBe(false);
  }, 300_000);

  it("route (a) without restrict-eval: the view alone keeps the marker out (the directory does not exist for the client)", () => {
    const a = setup(base, routeA);
    const r = runViewedOld(a.origin, a.rev);
    expect(r.stderr).toMatch(/does not exist|No such file/);
    expect(existsSync(a.storePath)).toBe(false);
  }, 120_000);

  it("route (b), an input missing from the lock, marker under the runner's home: control copies it; the step does not", async () => {
    const b = setup(homeBase, routeB);
    runDirect(b.origin, b.rev);
    expect(existsSync(b.storePath)).toBe(true); // control
    spawnSync(nixBin(), [...FEATURES, "store", "delete", b.storePath], { stdio: "ignore" });
    expect(existsSync(b.storePath)).toBe(false);

    const result = await runStep("data-b", b.origin, b.rev);
    if (!result.ok && result.skip === "nix_trusted_user") return;
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(lastStderr).toMatch(/does not exist/); // the home directory is not in the client's view
    expect(existsSync(b.storePath)).toBe(false);
  }, 300_000);

  it("route (b) with the marker in a directory of /tmp (not under home) is not reachable either", async () => {
    const b = setup(base, routeB);
    runDirect(b.origin, b.rev);
    expect(existsSync(b.storePath)).toBe(true); // control
    spawnSync(nixBin(), [...FEATURES, "store", "delete", b.storePath], { stdio: "ignore" });
    const result = await runStep("data-b2", b.origin, b.rev);
    if (!result.ok && result.skip === "nix_trusted_user") return;
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(lastStderr).toMatch(/does not exist/);
    expect(existsSync(b.storePath)).toBe(false);
  }, 300_000);

  it("second layer: a fetchTree of a directory the view does show (inside the mirror) is stopped by restrict-eval alone", async () => {
    const c = setup(base, routeA, LOCK, true);
    runViewedOld(c.origin, c.rev);
    expect(existsSync(c.storePath)).toBe(true); // control: shown to the client, so without restrict-eval it is copied
    spawnSync(nixBin(), [...FEATURES, "store", "delete", c.storePath], { stdio: "ignore" });
    expect(existsSync(c.storePath)).toBe(false);

    const result = await runStep("data-c", c.origin, c.rev);
    if (!result.ok && result.skip === "nix_trusted_user") return;
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(lastStderr).toMatch(/forbidden in restricted mode/);
    expect(existsSync(c.storePath)).toBe(false);
  }, 300_000);

  it("skips with a closed code, and starts nothing, when there is no bwrap: never an unsandboxed run", async () => {
    const a = setup(base, routeA);
    let started = 0;
    const counting = (...args: Parameters<typeof capture>) => {
      started += 1;
      return capture(...args);
    };
    const noView = createNixShell({ nixBin: nixBin(), bwrapBin: undefined, capture: counting, dataDir: path.join(base, "data-none"), identity: identityVia(capture) });
    expect(await noView.prepare({ approved: true, sha: a.rev, source: { kind: "flake", mirrorDir: a.origin, lock: LOCK } })).toEqual({ ok: false, skip: "nix_view_unavailable" });
    expect(started).toBe(0);
    expect(existsSync(a.storePath)).toBe(false);
  }, 60_000);

  it("a locked github input still evaluates under restrict-eval inside the view (network; skips when the control cannot fetch)", async () => {
    const lock = JSON.stringify({
      nodes: {
        root: { inputs: { fc: "fc" } },
        fc: { locked: { type: "github", owner: "nix-systems", repo: "default", rev: "d36eeed142f88b5a636f2e3856a53c61654cf29b", narHash: "sha256-uuanbkFk8a313Zfrxdcz8Us/yQtaxNnKJtX8v0ZPpd8=", lastModified: 1791244623 }, original: { type: "github", owner: "nix-systems", repo: "default" } },
      },
      root: "root",
      version: 7,
    });
    const flake = () => `{
  inputs.fc = { url = "github:nix-systems/default"; };
  outputs = { self, fc }: { devShells.x86_64-linux.default = ${shell("src = fc;")}; };
}
`;
    const d = setup(base, flake, lock);
    // Evaluation that gets all the way to the shell derivation ends at nix develop's own "bash as builder" refusal (the fixture has no bash); anything earlier is another failure.
    const REACHED = /only works on derivations that use 'bash' as their builder/;
    const control = runViewedOld(d.origin, d.rev); // the view, no restrict-eval: the github input is fetched over the network or it is not
    if (!REACHED.test(control.stderr)) return; // offline, or the host cannot fetch: nothing to compare against
    expect(NIX_FIXED_ARGS.join(" ")).toContain("--option restrict-eval true");
    const result = await runStep("data-d", d.origin, d.rev, lock);
    if (!result.ok && result.skip === "nix_trusted_user") return;
    expect(result).toEqual({ ok: false, skip: "nix_failed" });
    expect(lastStderr).toMatch(REACHED);
    expect(lastStderr).not.toMatch(/restricted mode/);
  }, 400_000);
});
