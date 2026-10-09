import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWANCE_REFUSALS, allowanceFloorViolation, type AllowanceEntry } from "@fulcrumaxe/runner-protocol";
import { verifyJob } from "../src/daemon/verifyJob.js";
import { JOB_ENV_NAMES, cleanEnv } from "../src/job/cleanEnv.js";
import { allowanceRefusal, grantsOf, jobEnvFor, storeKeyOf } from "../src/sandbox/allowances.js";
import { HostSandboxRefused, createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { NIX_DAEMON_SOCKET_DIR } from "../src/sandbox/nixView.js";
import { SandboxGrantRefused, sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { KEYRING, NOW, jobFor, signRaw, signedJob } from "./helpers/signedJob.js";

const entry = (kind: AllowanceEntry["kind"], value: string, access: AllowanceEntry["access"]): AllowanceEntry => ({ kind, value, access, reason: "needed by a step" });
const rw = (value: string, access: "read" | "write" = "read"): AllowanceEntry => entry("path", value, access);
const timeout = 600;

/** One entry for each way the floor (C15 section 3, tightened by R7a) says no. The runner must refuse every one, however it was signed. */
const FLOOR: Array<[string, AllowanceEntry]> = [
  ["the home directory", rw("/home/jane")],
  ["a path under a home directory", rw("/home/jane/project")],
  ["a macOS home", rw("/Users/jane/Library")],
  ["root's home", rw("/root/x")],
  ["ssh keys under /tmp", rw("/tmp/x/.ssh/id_ed25519")],
  ["a gh config", rw("/tmp/x/.config/gh/hosts.yml")],
  ["/etc", rw("/etc")],
  ["a file under /etc", rw("/etc/shadow")],
  ["/", rw("/")],
  ["a climb out of /tmp", rw("/tmp/../etc/passwd", "write")],
  ["the Nix daemon socket", rw("/nix/var/nix/daemon-socket/socket")],
  ["a docker socket", rw("/run/docker.sock")],
  ["a write outside /tmp", rw("/opt/cache", "write")],
  ["/dev/shm", rw("/dev/shm/x", "write")],
  ["a wildcard domain", entry("domain", "*.example.com", "connect")],
  ["a bare IPv4 address", entry("domain", "93.184.216.34", "connect")],
  ["a private address", entry("domain", "10.0.0.5", "connect")],
  ["the metadata address", entry("domain", "169.254.169.254", "connect")],
  ["an IPv6 literal", entry("domain", "[::1]", "connect")],
  ["a private suffix", entry("domain", "metadata.google.internal", "connect")],
  ["a domain with write access", entry("domain", "registry.npmjs.org", "write")],
  ["a path with connect access", entry("path", "/tmp/x", "connect")],
  ["a loopback that is not 127.0.0.1", entry("loopback", "0.0.0.0", "bind")],
];

describe("R7b: the runner's own floor check", () => {
  it.each(FLOOR)("refuses %s, and agrees with the protocol's one floor function", (_name, bad) => {
    expect(allowanceFloorViolation(bad)).not.toBeNull();
    const refused = allowanceRefusal({ entries: [rw("/nix/store"), bad], commandTimeoutS: timeout });
    expect(refused).not.toBeNull();
    expect(ALLOWANCE_REFUSALS).toContain(refused);
  });

  it("passes a set the floor allows: the Nix store to read, a scratch directory to write, the registry, the loopback bind", () => {
    const clean = [rw("/nix/store"), rw("/tmp/fx-scratch", "write"), entry("domain", "registry.npmjs.org", "connect"), entry("loopback", "127.0.0.1", "bind")];
    expect(allowanceRefusal({ entries: clean, commandTimeoutS: timeout })).toBeNull();
  });

  it("refuses a set the protocol reads as malformed: a duplicate, no entries, a timeout past the bound", () => {
    expect(allowanceRefusal({ entries: [rw("/nix/store"), rw("/nix/store")], commandTimeoutS: timeout })).toBe("duplicate_entry");
    expect(allowanceRefusal({ entries: [], commandTimeoutS: timeout })).not.toBeNull();
    expect(allowanceRefusal({ entries: [rw("/nix/store")], commandTimeoutS: 1801 })).toBe("invalid_shape");
  });

  it("turns entries into the four things the builder takes, and nothing else", () => {
    const grants = grantsOf([rw("/nix/store"), rw("/tmp/a", "write"), entry("domain", "registry.npmjs.org", "connect"), entry("loopback", "127.0.0.1", "bind")]);
    expect(grants).toEqual({ readPaths: ["/nix/store"], writePaths: ["/tmp/a"], domains: ["registry.npmjs.org"], loopback: true });
    expect(grantsOf([])).toEqual({ readPaths: [], writePaths: [], domains: [], loopback: false });
  });
});

describe("R7b: verifyJob refuses a floor violation before any process starts", () => {
  const signedWith = (entries: AllowanceEntry[]) => signRaw(jobFor({ sandbox_allowances: { entries, command_timeout_s: timeout } }));

  it.each(FLOOR)("a validly signed job with %s is sandbox_allowance_forbidden", (_name, bad) => {
    // the control: the same job without the bad entry passes, so the refusal is the entry's and not the signature's
    expect(verifyJob(signedWith([rw("/nix/store")]), KEYRING, NOW).ok).toBe(true);
    expect(verifyJob(signedWith([rw("/nix/store"), bad]), KEYRING, NOW)).toEqual({ ok: false, reason: "sandbox_allowance_forbidden" });
  });

  it("a job whose allowances changed after signing is a bad signature, not a floor refusal", () => {
    const good = signedWith([rw("/nix/store")]) as { job: { sandbox_allowances: { entries: AllowanceEntry[] } }; signature: string };
    const tampered = { ...good, job: { ...good.job, sandbox_allowances: { ...good.job.sandbox_allowances, entries: [rw("/nix/store"), entry("domain", "evil.example.com", "connect")] } } };
    expect(verifyJob(tampered, KEYRING, NOW)).toEqual({ ok: false, reason: "job_signature_invalid" });
  });

  it("a job with no allowances is unchanged", () => {
    const signed = signedJob();
    expect(verifyJob(signed, KEYRING, NOW)).toEqual({ ok: true, job: signed.job });
  });
});

describe("R7b: the per-job environment", () => {
  it("carries the timeout in milliseconds for the Bash tool, a cache directory under the job's temp directory and the repo's store with integrity checks on", () => {
    expect(jobEnvFor({ tempDir: "/t/rn-1", store: "/c/pnpm-store/acme__widgets", commandTimeoutS: 900 })).toEqual({
      XDG_CACHE_HOME: "/t/rn-1/xdg-cache",
      pnpm_config_store_dir: "/c/pnpm-store/acme__widgets",
      pnpm_config_verify_store_integrity: "true",
      BASH_DEFAULT_TIMEOUT_MS: "900000",
      BASH_MAX_TIMEOUT_MS: "900000",
    });
    expect(jobEnvFor({ tempDir: "/t/rn-1", commandTimeoutS: 1800 })).not.toHaveProperty("pnpm_config_store_dir");
    // keyed by the repo's id, like the mirrors: a name with ".." is valid, and a recreated repo (new id) never inherits the old store
    expect(storeKeyOf({ id: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f" })).toBe("0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f");
  });

  it("is added to the clean environment by name, and nothing else can be: a credential name or a control character is refused", () => {
    const env = cleanEnv({ mode: "subscription" }, { jobEnv: jobEnvFor({ tempDir: "/t/x", store: "/s/a", commandTimeoutS: 60 }) });
    for (const name of JOB_ENV_NAMES) expect(env[name], name).toBeDefined();
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe("60000");
    expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { ANTHROPIC_API_KEY: "sk-x" } })).toThrow(TypeError);
    expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { LD_PRELOAD: "/tmp/x.so" } })).toThrow(TypeError);
    expect(() => cleanEnv({ mode: "subscription" }, { jobEnv: { XDG_CACHE_HOME: "/t\nx" } })).toThrow(TypeError);
    // without it the environment is exactly what it was
    expect(Object.keys(cleanEnv({ mode: "subscription" }))).not.toContain("BASH_DEFAULT_TIMEOUT_MS");
  });
});

describe("R7b: the sandbox builder applies the allowances, and keeps its own refusals", () => {
  const HOME = "/home/jane";
  const base = { workspace: `${HOME}/.cache/fx-runner/workspaces/run-1`, tempDir: `${HOME}/.cache/fx-runner/tmp/rn-1`, home: HOME, stateDir: `${HOME}/.fx-runner`, binaryDir: `${HOME}/.local/bin`, workspaceRoot: `${HOME}/.cache/fx-runner/workspaces`, tempRoot: `${HOME}/.cache/fx-runner/tmp` };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = (over: Partial<Parameters<typeof sandboxSettings>[0]> = {}) => sandboxSettings({ ...base, ...over }) as Record<string, any>;

  it("adds a write path to the writable and readable lists, a read path to the readable list only, a domain and the loopback bind", () => {
    const b = block({ allowanceWritePaths: ["/tmp/fx-scratch"], allowanceReadPaths: ["/nix/store"], extraDomains: ["registry.npmjs.org"], allowLoopbackBind: true });
    expect(b.filesystem.allowWrite).toEqual([base.workspace, base.tempDir, "/tmp/fx-scratch"]);
    expect(b.filesystem.allowRead).toEqual(expect.arrayContaining(["/nix/store", "/tmp/fx-scratch"]));
    expect(b.filesystem.allowWrite).not.toContain("/nix/store");
    expect(b.network).toEqual({ allowedDomains: ["api.anthropic.com", "registry.npmjs.org"], strictAllowlist: true, allowLocalBinding: true });
  });

  it("changes nothing without allowances: no loopback bind, no extra path", () => {
    const b = block();
    expect(b.network.allowLocalBinding).toBe(false);
    expect(b.filesystem.allowWrite).toEqual([base.workspace, base.tempDir]);
  });

  it("the repo's package store sits in the runner's cache directory and is writable and readable, and only that store", () => {
    const root = `${HOME}/.cache/fx-runner/pnpm-store`;
    const dir = `${root}/acme__widgets`;
    const b = block({ packageStore: { root, dir } });
    expect(b.filesystem.allowWrite).toContain(dir);
    expect(b.filesystem.allowRead).toContain(dir);
    expect(b.filesystem.allowWrite).not.toContain(root);
    expect(() => block({ packageStore: { root, dir: root } })).toThrow(SandboxGrantRefused);
    expect(() => block({ packageStore: { root, dir: `${HOME}/.ssh` } })).toThrow(SandboxGrantRefused);
    expect(() => block({ packageStore: { root: `${HOME}/.cache/fx-runner`, dir: `${HOME}/.cache/fx-runner/workspaces/x` } })).toThrow(SandboxGrantRefused);
  });

  it.each([
    ["the home directory", HOME],
    ["a parent of the home directory", "/home"],
    ["a path in the home directory", `${HOME}/work`],
    ["the credential floor", `${HOME}/.ssh`],
    ["the state directory", `${HOME}/.fx-runner`],
    ["a parent of the workspaces", `${HOME}/.cache/fx-runner`],
    ["the root", "/"],
    ["a socket", "/run/user/1000/bus.sock"],
    ["a relative path", "tmp/x"],
  ])("refuses a path allowance over %s", (_name, value) => {
    expect(() => block({ allowanceReadPaths: [value] })).toThrow(SandboxGrantRefused);
    expect(() => block({ allowanceWritePaths: [value] })).toThrow(SandboxGrantRefused);
  });

  it("refuses an allowance that reaches the other jobs: a parent of the temp root or the mirrors root", () => {
    const outside = { ...base, tempDir: "/srv/fx/tmp/rn-1", tempRoot: "/srv/fx/tmp", home: HOME };
    expect(() => sandboxSettings({ ...outside, allowanceReadPaths: ["/srv/fx"] })).toThrow(/protected location|overlap/);
    expect(() => sandboxSettings({ ...outside, allowanceReadPaths: ["/srv/fx/tmp"] })).toThrow(SandboxGrantRefused);
    expect(() => sandboxSettings({ ...outside, allowanceReadPaths: ["/srv/other"] })).not.toThrow();
  });
});

describe("R7b: the host sandbox re-checks the floor and applies the set to that job only", () => {
  const dirs: string[] = [];
  // the write entries of these tests live in /tmp (the floor), under names no other test or program uses
  const SCRATCH_A = `/tmp/r7b-scratch-a-${process.pid}`;
  const SCRATCH_B = `/tmp/r7b-scratch-b-${process.pid}`;
  afterEach(() => {
    for (const dir of [...dirs.splice(0), SCRATCH_A, SCRATCH_B]) rmSync(dir, { recursive: true, force: true });
  });

  function rig(opts: { runtimeFails?: boolean } = {}) {
    const root = mkdtempSync(path.join("/tmp", "r7b-host-"));
    dirs.push(root);
    const home = path.join(root, "home");
    const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
    const workspaceRoot = path.join(home, ".cache", "fx-runner", "workspaces");
    const storeRoot = path.join(home, ".cache", "fx-runner", "pnpm-store");
    mkdirSync(workspaceRoot, { recursive: true });
    const blocks: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const envs: Array<Record<string, string> | undefined> = [];
    const host = createHostSandbox({
      credentials: { mode: "subscription" },
      home,
      stateDir: path.join(home, ".fx-runner"),
      binaryDir: path.join(root, "bin"),
      tempRoot,
      workspaceRoot,
      packageStoreRoot: storeRoot,
      makeRuntime: (sandbox, _protected, jobEnv) => {
        if (opts.runtimeFails === true) throw new Error("runtime cannot be built");
        blocks.push(sandbox);
        envs.push(jobEnv);
        return { start: async (opts) => ({ handle: { runId: opts.runId, done: Promise.resolve() } }), stop: async () => undefined, resume: async (handle) => ({ handle }) };
      },
    });
    let n = 0;
    const handles: Array<Awaited<ReturnType<typeof host.createSandbox>>> = [];
    async function launch(allowances?: Parameters<typeof host.startDetached>[1]["allowances"]): Promise<void> {
      n += 1;
      const workdir = path.join(workspaceRoot, `run-${n}`);
      mkdirSync(workdir);
      const handle = await host.createSandbox({ sandboxName: `rn-${n}`, retention: { persistent: false }, timeoutMs: 60_000 });
      handles.push(handle);
      const started = host.startDetached(handle, {
        runId: "run", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0,
        networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined,
        ...(allowances === undefined ? {} : { allowances }),
      });
      await started.launched;
    }
    return { launch, blocks, envs, storeRoot, home, tempRoot, host, handles };
  }
  const grant = (over: Partial<NonNullable<Parameters<ReturnType<typeof rig>["launch"]>[0]>> = {}) => ({
    entries: [rw("/nix/store"), rw(SCRATCH_A, "write"), entry("domain", "registry.npmjs.org", "connect"), entry("loopback", "127.0.0.1", "bind")],
    commandTimeoutS: 1200,
    storeKey: "acme__widgets",
    ...over,
  });

  it("repo A's job gets its entries, its store, its cache directory and its timeout; repo B's job on the same runner gets none of them", async () => {
    const r = rig();
    await r.launch(grant());
    await r.launch();
    const [a, b] = r.blocks;
    expect(a!.filesystem.allowWrite).toEqual(expect.arrayContaining([SCRATCH_A, path.join(r.storeRoot, "acme__widgets")]));
    expect(a!.network.allowedDomains).toContain("registry.npmjs.org");
    expect(a!.network.allowLocalBinding).toBe(true);
    expect(r.envs[0]).toMatchObject({ BASH_DEFAULT_TIMEOUT_MS: "1200000", BASH_MAX_TIMEOUT_MS: "1200000", pnpm_config_store_dir: path.join(r.storeRoot, "acme__widgets"), pnpm_config_verify_store_integrity: "true" });
    // repo B: the plain block, exactly, and no per-job environment
    // (the store root is in B's denyRead, like everyone's; it is in no allow list)
    expect(JSON.stringify({ ...b!.filesystem, denyRead: [] })).not.toMatch(/r7b-scratch-a|pnpm-store/);
    expect(JSON.stringify(b)).not.toMatch(/r7b-scratch-a|registry\.npmjs|\/nix\/store/);
    expect(b!.network.allowLocalBinding).toBe(false);
    expect(r.envs[1]).toBeUndefined();
  });

  it("D#6 R7c: the Nix daemon socket directory is denied to every job: none, one with allowances but no dev shell, and one with a dev shell", async () => {
    const r = rig();
    await r.launch();
    await r.launch(grant());
    await r.launch(grant({ entries: [rw("/nix/store"), rw(SCRATCH_B, "write")], nixEnv: { PATH: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-tool/bin" } }));
    const [plain, allowed, shell] = r.blocks;
    for (const block of [plain!, allowed!, shell!]) expect(block.filesystem.denyRead).toContain(NIX_DAEMON_SOCKET_DIR);
    // the store is readable only for the job that has a dev shell: the job with allowances but no shell gets the entries it was signed for and nothing from the view
    expect(plain!.filesystem.allowRead).not.toContain("/nix/store");
    expect(shell!.filesystem.allowRead).toContain("/nix/store");
    expect(shell!.filesystem.allowWrite).not.toContain(NIX_DAEMON_SOCKET_DIR);
  });

  it("two repos get two stores, and a store is made only for a job that carries allowances", async () => {
    const r = rig();
    await r.launch(grant({ storeKey: "acme__one" }));
    await r.launch(grant({ storeKey: "acme__two", entries: [rw("/nix/store"), rw(SCRATCH_B, "write")] }));
    const stores = r.envs.map((env) => env?.pnpm_config_store_dir);
    expect(new Set(stores).size).toBe(2);
    const second = r.blocks[1]!;
    expect(second.filesystem.allowWrite).not.toContain(stores[0]);
    const fresh = rig();
    await fresh.launch();
    expect(() => mkdirSync(fresh.storeRoot)).not.toThrow();
  });

  it("refuses closed on a violation: nothing is built, no runtime is made, no directory is created", async () => {
    for (const [, bad] of FLOOR) {
      const r = rig();
      await expect(r.launch(grant({ entries: [rw("/nix/store"), bad] }))).rejects.toMatchObject({ code: "sandbox_allowance_forbidden" });
      expect(r.blocks).toEqual([]);
      expect(() => mkdirSync(r.storeRoot)).not.toThrow();
    }
  });

  it("refuses a store key that is not one plain word, and a grant the builder refuses", async () => {
    const r = rig();
    await expect(r.launch(grant({ storeKey: "../escape" }))).rejects.toBeInstanceOf(HostSandboxRefused);
    // Bare /tmp no longer clears the protocol's floor (path_bare_tmp). This directory under /tmp does, but here it holds the runner's own home,
    // so the builder refuses it and the job does not start
    await expect(r.launch(grant({ entries: [rw(path.dirname(r.home)), rw("/nix/store")] }))).rejects.toBeInstanceOf(SandboxGrantRefused);
    expect(r.blocks).toEqual([]);
  });
  it("repo B's job (no allowances) has the package-store root denied for reading, and no store of its own", async () => {
    const r = rig();
    await r.launch(grant());
    await r.launch();
    const [a, b] = r.blocks;
    expect(a!.filesystem.denyRead).toContain(r.storeRoot);
    expect(b!.filesystem.denyRead).toContain(r.storeRoot);
    expect(b!.filesystem.allowRead).not.toContain(path.join(r.storeRoot, "acme__widgets"));
  });

  describe("write entries are job-scoped (no write outlives the job)", () => {
    const write = (value: string) => grant({ entries: [rw("/nix/store"), rw(value, "write")] });

    it("makes the directory fresh (0700, owned by the runner's user) right before launch, and removes it, contents and all, when the sandbox is deleted", async () => {
      const r = rig();
      expect(existsSync(SCRATCH_A)).toBe(false);
      await r.launch(write(SCRATCH_A));
      const st = lstatSync(SCRATCH_A);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700);
      expect(st.uid).toBe(process.getuid!());
      mkdirSync(path.join(SCRATCH_A, "deep", "er"), { recursive: true });
      writeFileSync(path.join(SCRATCH_A, "deep", "er", "f"), "x");
      await r.host.deleteSandbox(r.handles[0]!);
      expect(existsSync(SCRATCH_A)).toBe(false);
    });

    it("refuses a path that exists before the job, whatever it is, and leaves it as it was", async () => {
      const r = rig();
      mkdirSync(SCRATCH_A);
      writeFileSync(path.join(SCRATCH_A, "theirs"), "keep");
      await expect(r.launch(write(SCRATCH_A))).rejects.toMatchObject({ code: "sandbox_allowance_forbidden", message: expect.stringContaining("write_path_exists") });
      expect(existsSync(path.join(SCRATCH_A, "theirs"))).toBe(true);
      expect(r.blocks).toEqual([]);
      // a file at the path is refused too
      writeFileSync(SCRATCH_B, "file");
      await expect(rig().launch(write(SCRATCH_B))).rejects.toMatchObject({ code: "sandbox_allowance_forbidden" });
      expect(statSync(SCRATCH_B).isFile()).toBe(true);
    });

    it("refuses a path another job made: its directory is not adopted, and survives until its own job ends", async () => {
      const r = rig();
      await r.launch(write(SCRATCH_A));
      writeFileSync(path.join(SCRATCH_A, "first-job"), "x");
      await expect(r.launch(write(SCRATCH_A))).rejects.toMatchObject({ code: "sandbox_allowance_forbidden", message: expect.stringContaining("write_path_exists") });
      expect(existsSync(path.join(SCRATCH_A, "first-job"))).toBe(true);
      await r.host.deleteSandbox(r.handles[0]!);
      expect(existsSync(SCRATCH_A)).toBe(false);
    });

    it("refuses when the parent does not exist, and makes no second directory when a later entry is refused", async () => {
      const r = rig();
      await expect(r.launch(write(`${SCRATCH_A}/no/parent`))).rejects.toMatchObject({ message: expect.stringContaining("write_parent_missing") });
      expect(existsSync(SCRATCH_A)).toBe(false);
      mkdirSync(SCRATCH_B);
      await expect(r.launch(grant({ entries: [rw(SCRATCH_A, "write"), rw(SCRATCH_B, "write")] }))).rejects.toMatchObject({ message: expect.stringContaining("write_path_exists") });
      expect(existsSync(SCRATCH_A)).toBe(false);
    });

    it("is gone after a failed job too: a launch that fails after the directory was made, and a sandbox deleted with its agent still up", async () => {
      // the runtime cannot be built, which happens after the directory was made
      await expect(rig({ runtimeFails: true }).launch(write(SCRATCH_A))).rejects.toThrow("runtime cannot be built");
      expect(existsSync(SCRATCH_A)).toBe(false);
      const r = rig();
      await r.launch(write(SCRATCH_A));
      expect(existsSync(SCRATCH_A)).toBe(true);
      await r.host.stop(r.handles[0]!);
      await r.host.deleteSandbox(r.handles[0]!);
      expect(existsSync(SCRATCH_A)).toBe(false);
    });

    it("never follows a symlink on removal: a link planted inside to a directory elsewhere is unlinked, and the target and its contents stay", async () => {
      const r = rig();
      const outside = mkdtempSync(path.join("/tmp", "r7b-outside-"));
      dirs.push(outside);
      writeFileSync(path.join(outside, "precious"), "keep");
      await r.launch(write(SCRATCH_A));
      symlinkSync(outside, path.join(SCRATCH_A, "link-dir"));
      symlinkSync(path.join(outside, "precious"), path.join(SCRATCH_A, "link-file"));
      // a directory with no permissions, as an agent can leave it, does not stop the removal either
      mkdirSync(path.join(SCRATCH_A, "locked"));
      writeFileSync(path.join(SCRATCH_A, "locked", "f"), "x");
      (await import("node:fs")).chmodSync(path.join(SCRATCH_A, "locked"), 0o000);
      await r.host.deleteSandbox(r.handles[0]!);
      expect(existsSync(SCRATCH_A)).toBe(false);
      expect(existsSync(path.join(outside, "precious"))).toBe(true);
    });

    it("does not touch a directory that is no longer the one it made", async () => {
      const r = rig();
      await r.launch(write(SCRATCH_A));
      const elsewhere = mkdtempSync(path.join("/tmp", "r7b-swap-"));
      dirs.push(elsewhere);
      writeFileSync(path.join(elsewhere, "theirs"), "keep");
      rmSync(SCRATCH_A, { recursive: true });
      symlinkSync(elsewhere, SCRATCH_A);
      await r.host.deleteSandbox(r.handles[0]!);
      expect(existsSync(path.join(elsewhere, "theirs"))).toBe(true);
    });
  });
});
