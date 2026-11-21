import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_HEADER_END, CHECK_SUMMARY_MAX_BYTES } from "@fulcrumaxe/runner-protocol";
import { createCheckInVm, createFreshVmCheck, pinnedNames, runGuestCheck, type FreshCheckPort } from "../../../src/vm/workspace/guestCheck.js";
import { runInGuest } from "../../../src/vm/workspace/guestWorkspace.js";
import type { SdkSandbox } from "../../../src/vm/sandboxd/sdkSlice.js";
import { buildWorkspaceArchive } from "../../../src/daemon/vmArchive.js";
import { createGit } from "../../../src/daemon/git.js";
import { fixtureRepo, GIT_ENV, localGuest, scratchDir } from "./helpers.js";
import { MICROVM_PINNED_ENV } from "../../../src/vm/sandboxd/guestEnv.js";

const NOW = (): Date => new Date();
/** The guest's `PATH` is its own (`/usr/bin` and the like), which a Nix host does not have: the few programs a test script needs are named by absolute path. */
const BIN = (name: string): string => execFileSync("which", [name], { encoding: "utf8" }).trim();

/** A guest whose workspace holds `files` (path to content, mode). */
function guestWith(files: Record<string, string | { body: string; mode: number }>) {
  const g = localGuest();
  for (const [rel, spec] of Object.entries(files)) {
    const file = path.join(g.paths.workspace, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const { body, mode } = typeof spec === "string" ? { body: spec, mode: 0o644 } : spec;
    writeFileSync(file, body);
    chmodSync(file, mode);
  }
  mkdirSync(g.paths.stage, { recursive: true });
  return g;
}
const baseFiles = (map: Record<string, string | null>) => async (relative: string): Promise<Buffer | null> => {
  const hit = map[relative];
  return hit === undefined || hit === null ? null : Buffer.from(hit);
};

describe("the approved check runs in the guest", () => {
  it("a passing check reports the host's shape: exit 0, a duration, no time-out, the header end line, no failed files", async () => {
    const g = guestWith({ "scripts/check.sh": "echo checked in $(pwd)\necho 'Tests  4 passed | 2 skipped (6)'\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.passed).toBe(true);
    expect(outcome.body).toMatchObject({ exit_code: 0, timed_out: false, skipped_tests: 2 });
    expect(outcome.body.summary.startsWith(`${CHECK_HEADER_END}\n`)).toBe(true);
    // the guest's workspace path is not shown: `<workspace>` stands for it, as on the host
    expect(outcome.body.summary).toContain("checked in <workspace>");
    expect(outcome.body.summary).not.toContain(g.paths.workspace);
    expect(outcome.body).not.toHaveProperty("failed_files");
    expect(g.sent.commands.find((c) => c.cmd === "sh" && c.args[0] === "scripts/check.sh")?.cwd).toBe(g.paths.workspace);
  });

  it("a failing check keeps its exit code, names the failed test files and carries the last output after the header", async () => {
    const g = guestWith({ "scripts/check.sh": "echo ' FAIL  src/a.test.ts > it works'\necho 'Error: nope' >&2\nexit 3\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.passed).toBe(false);
    expect(outcome.body.exit_code).toBe(3);
    expect(outcome.body.failed_files).toEqual(["src/a.test.ts"]);
    const [header, output] = outcome.body.summary.split(`${CHECK_HEADER_END}\n`);
    expect(header).toContain("src/a.test.ts");
    expect(output).toContain("Error: nope");
    expect(Buffer.byteLength(outcome.body.summary)).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_BYTES);
  });

  it("a check that outlives its time limit is killed and reported as timed out with no exit code", async () => {
    const g = guestWith({ "scripts/check.sh": "while :; do :; done\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 1 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.passed).toBe(false);
    expect(outcome.body).toMatchObject({ exit_code: null, timed_out: true });
  }, 20_000);

  /** A guest the way the production daemon's commands behave: a command's output is handed over when the command ends, not while it runs. */
  const endDelivered = (guest: SdkSandbox): SdkSandbox =>
    ({
      ...guest,
      async runCommand(params: Parameters<SdkSandbox["runCommand"]>[0]) {
        const command = await guest.runCommand(params);
        return {
          ...command,
          async *logs() {
            await command.wait();
            yield* command.logs();
          },
        };
      },
    }) as unknown as SdkSandbox;

  it("a timed-out check keeps the bounded output it produced before the limit, even when the guest hands output over only when the command ends", async () => {
    const g = guestWith({ "scripts/check.sh": "echo printed-before-the-limit\necho and-this-on-stderr >&2\nwhile :; do :; done\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 1 }, guest: endDelivered(g.guest), baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.body).toMatchObject({ exit_code: null, timed_out: true });
    const output = outcome.body.summary.split(`${CHECK_HEADER_END}\n`)[1];
    expect(output).toContain("printed-before-the-limit");
    expect(output).toContain("and-this-on-stderr");
    expect(Buffer.byteLength(outcome.body.summary)).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_BYTES);
  }, 30_000);

  it("a command that prints a flood and then outlives its limit keeps only the end of what it printed", async () => {
    const g = guestWith({ "scripts/check.sh": "i=0\nwhile [ $i -lt 4000 ]; do echo \"line-$i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"; i=$((i+1)); done\nwhile :; do :; done\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 2 }, guest: endDelivered(g.guest), baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.body.timed_out).toBe(true);
    expect(outcome.body.summary).toContain("line-3999");
    expect(outcome.body.summary).not.toContain("line-0 ");
    expect(Buffer.byteLength(outcome.body.summary)).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_BYTES);
  }, 30_000);

  it("a guest that never hands the output over does not hold a timed-out check past its limit by more than the drain wait", async () => {
    const g = guestWith({ "scripts/check.sh": "echo started\nwhile :; do :; done\n" });
    const silent = { ...g.guest, async runCommand(params: Parameters<SdkSandbox["runCommand"]>[0]) {
      const command = await g.guest.runCommand(params);
      return { ...command, async *logs() { await new Promise(() => undefined); }, async wait() { return new Promise(() => undefined); } };
    } } as unknown as SdkSandbox;
    const began = Date.now();
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 1 }, guest: silent, baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.body).toMatchObject({ exit_code: null, timed_out: true });
    expect(Date.now() - began).toBeLessThan(25_000);
  }, 40_000);

  it("the vector goes in as separate arguments: nothing is parsed by a shell, and the environment is the guest's closed one", async () => {
    const g = guestWith({ "scripts/check.sh": "echo \"$1\"\n" });
    const odd = "$(touch pwned);`touch pwned2`";
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh", odd], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths });
    expect(outcome.body.summary).toContain(odd);
    expect(existsSync(path.join(g.paths.workspace, "pwned"))).toBe(false);
    const run = g.sent.commands.find((c) => c.args.includes(odd));
    expect(run?.args).toEqual(["scripts/check.sh", odd]);
    for (const [name, value] of Object.entries(MICROVM_PINNED_ENV)) expect(run?.env?.[name], name).toBe(value);
    expect(Object.keys(run?.env ?? {}).filter((n) => /TOKEN|CREDENTIAL|_KEY$/.test(n))).toEqual([]);
  });

  it("the file the vector names is put back to the pinned content for the run, and the agent's version is given back after", async () => {
    const g = guestWith({ "scripts/check.sh": { body: "echo AGENT-EDITED-CHECK\nexit 0\n", mode: 0o755 } });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({ "scripts/check.sh": "echo PINNED-CHECK\nexit 4\n" }), now: NOW, paths: g.paths });
    expect(outcome.body.exit_code).toBe(4);
    expect(outcome.body.summary).toContain("PINNED-CHECK");
    expect(outcome.body.summary).not.toContain("AGENT-EDITED-CHECK");
    expect(readFileSync(path.join(g.paths.workspace, "scripts/check.sh"), "utf8")).toBe("echo AGENT-EDITED-CHECK\nexit 0\n");
    expect(statSync(path.join(g.paths.workspace, "scripts/check.sh")).mode & 0o777).toBe(0o755);
    expect(existsSync(path.join(g.paths.stage, "pins"))).toBe(false);
  });

  it("a file the default branch does not have is not pinned; a pinned file the agent deleted is absent for no run and absent again after", async () => {
    const g = guestWith({ "scripts/check.sh": "echo ok\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh", "scripts/new-only.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({ "scripts/check.sh": "echo ok\n" }), now: NOW, paths: g.paths });
    expect(outcome.passed).toBe(true);
    expect(existsSync(path.join(g.paths.workspace, "scripts/new-only.sh"))).toBe(false);
    const gone = guestWith({});
    const again = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: gone.guest, baseFile: baseFiles({ "scripts/check.sh": "echo pinned-only\n" }), now: NOW, paths: gone.paths });
    expect(again.body.summary).toContain("pinned-only");
    expect(existsSync(path.join(gone.paths.workspace, "scripts/check.sh"))).toBe(false);
  });

  it("a link on a pinned path, or one of its parent directories, fails the check as pin_failed and nothing runs", async () => {
    const g = guestWith({ "real/check.sh": "echo SHOULD-NOT-RUN\n" });
    symlinkSync(path.join(g.paths.workspace, "real/check.sh"), path.join(g.paths.workspace, "linked.sh"));
    symlinkSync(path.join(g.paths.workspace, "real"), path.join(g.paths.workspace, "dirlink"));
    for (const name of ["linked.sh", "dirlink/check.sh"]) {
      const outcome = await runGuestCheck({ check: { argv: ["sh", name], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({ [name]: "echo pinned\n" }), now: NOW, paths: g.paths });
      expect(outcome.passed, name).toBe(false);
      expect(outcome.body).toMatchObject({ exit_code: null, reason: "pin_failed" });
      expect(outcome.body.summary).not.toContain("SHOULD-NOT-RUN");
    }
    expect(g.sent.commands.some((c) => c.args.includes("linked.sh") && c.cmd === "sh" && c.cwd === g.paths.workspace)).toBe(false);
  });

  it("a directory where the pinned file should be fails the check as pin_failed", async () => {
    const g = guestWith({ "scripts/check.sh/inner.txt": "x" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({ "scripts/check.sh": "echo pinned\n" }), now: NOW, paths: g.paths });
    expect(outcome.body).toMatchObject({ exit_code: null, reason: "pin_failed" });
  });

  it("a base file that cannot be read exactly fails the check as pin_failed", async () => {
    const g = guestWith({ "scripts/check.sh": "echo ok\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: async () => Promise.reject(new Error("/host/secret/path")), now: NOW, paths: g.paths });
    expect(outcome.body.reason).toBe("pin_failed");
    expect(outcome.body.summary).not.toContain("/host/secret/path");
  });

  it("a vector that is empty, or has a NUL, is not started", async () => {
    const g = guestWith({});
    for (const argv of [[], ["sh", "a\0b"]]) expect((await runGuestCheck({ check: { argv, dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths })).body.reason, JSON.stringify(argv)).toBe("start_failed");
  });

  it("names only plain repo-relative files for pinning, in order, once each", () => {
    expect(pinnedNames(["sh", "./scripts//check.sh", "--flag", "/abs/x", "../up", "a b", "scripts/check.sh", "x/y.sh"])).toEqual(["sh", "scripts/check.sh", "x/y.sh"]);
  });
});

describe("pinned files go over as bytes", () => {
  it("a pinned file that is not UTF-8 reaches the check byte for byte, and the agent's version is given back byte for byte", async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0xfe, 0x00, 0x80]);
    const agents = Buffer.from([0x41, 0x80, 0x81, 0x0a]);
    const g = guestWith({ "scripts/check.sh": "echo placeholder\n" });
    writeFileSync(path.join(g.paths.workspace, "scripts/check.sh"), agents);
    // the check compares the file it finds with the bytes the default branch has
    const expectedHex = latin1.toString("hex");
    const outcome = await runGuestCheck({ check: { argv: ["sh", "-c", `[ "$(${BIN("od")} -An -tx1 -v scripts/check.sh | ${BIN("tr")} -d ' \\n')" = "${expectedHex}" ] && echo SAME || { echo DIFFERENT; exit 9; }`, "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: async (rel) => (rel === "scripts/check.sh" ? latin1 : null), now: NOW, paths: g.paths });
    expect(outcome.body.summary).toContain("SAME");
    expect(outcome.passed).toBe(true);
    expect(readFileSync(path.join(g.paths.workspace, "scripts/check.sh")).equals(agents)).toBe(true);
  });
});

describe("the directory the pinned files are sent to", () => {
  it("is made by the guest's own user before the transfer, because the real guest's transfer makes a missing directory as root and the agent user could not clean it", async () => {
    const g = guestWith({ "scripts/check.sh": "echo agent\n" });
    await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({ "scripts/check.sh": "echo pinned\n" }), now: NOW, paths: g.paths });
    const sentPins = g.sent.files.filter((f) => f.path.startsWith(`${g.paths.stage}/pin-in/`));
    expect(sentPins).toHaveLength(1);
    expect(sentPins.every((f) => f.parentExisted)).toBe(true);
    expect(existsSync(path.join(g.paths.stage, "pin-in"))).toBe(false);
  });
});

describe("a check that does not pass: the conditions that must each hold", () => {
  const unlessRoot = process.getuid?.() === 0 ? it.skip : it;

  unlessRoot("a pinned file that could not be given back means the check never passes, even with exit 0 (not_restored)", async () => {
    // the check makes the pinned file read-only, so the copy back over it fails
    const g = guestWith({ "scripts/check.sh": "echo agent\n" });
    const outcome = await runGuestCheck({ check: { argv: ["sh", "-c", `${BIN("chmod")} 444 scripts/check.sh; exit 0`, "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({ "scripts/check.sh": "echo pinned\n" }), now: NOW, paths: g.paths });
    expect(outcome.body.exit_code).toBe(0);
    expect(outcome.body.reason).toBe("not_restored");
    expect(outcome.passed).toBe(false);
  });

  it("a stop that arrives while the files are given back means the check never passes, even with exit 0", async () => {
    const g = guestWith({ "scripts/check.sh": "echo agent\n" });
    const stop = new AbortController();
    const inner = g.guest.runCommand.bind(g.guest);
    const guest = { ...g.guest, writeFiles: g.guest.writeFiles.bind(g.guest), updateNetworkPolicy: g.guest.updateNetworkPolicy.bind(g.guest), runCommand: (params: Parameters<SdkSandbox["runCommand"]>[0]) => {
      if (params.args?.includes("fx-restore") === true) stop.abort();
      return inner(params);
    } } as unknown as SdkSandbox;
    const outcome = await runGuestCheck({ check: { argv: ["sh", "-c", "exit 0", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest, baseFile: baseFiles({ "scripts/check.sh": "echo pinned\n" }), now: NOW, paths: g.paths, signal: stop.signal });
    expect(outcome.passed).toBe(false);
    expect(outcome.body.exit_code).toBeNull();
  });

  it("a stop that arrives mid-check kills the command within a moment and never passes", async () => {
    const g = guestWith({ "scripts/check.sh": `${BIN("touch")} started\n${BIN("sleep")} 30\n${BIN("touch")} finished\nexit 0\n` });
    const stop = new AbortController();
    const begun = Date.now();
    const running = runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 60 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths, signal: stop.signal });
    const marker = path.join(g.paths.workspace, "started");
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(marker)).toBe(true);
    stop.abort();
    const outcome = await running;
    expect(Date.now() - begun).toBeLessThan(10_000);
    expect(outcome.passed).toBe(false);
    expect(outcome.body).toMatchObject({ exit_code: null, timed_out: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(path.join(g.paths.workspace, "finished"))).toBe(false);
  }, 30_000);

  it("a stop that came before the check started runs nothing", async () => {
    const g = guestWith({ "scripts/check.sh": `${BIN("touch")} ran\n` });
    const stop = new AbortController();
    stop.abort();
    const outcome = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, guest: g.guest, baseFile: baseFiles({}), now: NOW, paths: g.paths, signal: stop.signal });
    expect(outcome.passed).toBe(false);
    expect(existsSync(path.join(g.paths.workspace, "ran"))).toBe(false);
  });

  it("the time limit starts before the guest is asked to start the command: a guest that never answers is bounded by the limit", async () => {
    const never = { runCommand: () => new Promise(() => undefined) } as unknown as SdkSandbox;
    const begun = Date.now();
    const result = await runInGuest(never, { cmd: "sh", args: [] }, 200);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - begun).toBeLessThan(5000);
    const stop = new AbortController();
    const later = runInGuest(never, { cmd: "sh", args: [] }, 60_000, 1024, undefined, stop.signal);
    stop.abort();
    expect(await later).toMatchObject({ exitCode: null, timedOut: false, aborted: true });
  });
});

describe("the check in a fresh VM", () => {
  /** A host repository whose tip carries the check script; the port makes a fresh local guest for each `createSandbox`. */
  function freshRig(scriptBody: string, over: { archiveFails?: boolean; createFails?: boolean } = {}) {
    const fx = fixtureRepo((dir) => (mkdirSync(path.join(dir, "scripts")), writeFileSync(path.join(dir, "scripts/check.sh"), scriptBody)));
    const capture = async (command: string, args: readonly string[], env: Record<string, string>) => {
      try {
        return { code: 0, stdout: execFileSync(command, [...args], { env: { ...GIT_ENV(), ...env }, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }), timedOut: false };
      } catch (error) {
        return { code: (error as { status?: number }).status ?? 1, stdout: "", timedOut: false };
      }
    };
    const gitLike = createGit({ capture });
    const scratch = scratchDir("fxw-fresh-");
    const guestRoot = scratchDir("fxw-checkvm-");
    const paths = localGuest(guestRoot).paths;
    const made: Array<{ name: string; guest: ReturnType<typeof localGuest> }> = [];
    const deleted: string[] = [];
    const port: FreshCheckPort = {
      async createSandbox(opts) {
        if (over.createFails === true) throw new Error("/host/secret/path");
        made.push({ name: opts.sandboxName, guest: localGuest(guestRoot) });
        return { runId: "", sandboxName: opts.sandboxName };
      },
      async deleteSandbox(handle) {
        deleted.push(handle.sandboxName);
      },
      async guestOf(handle) {
        const hit = made.find((m) => m.name === handle.sandboxName);
        if (hit === undefined) throw new Error("not found");
        return hit.guest.guest;
      },
    };
    const archive = async (repoDir: string, commit: string) => (over.archiveFails === true ? Promise.reject(new Error("/host/secret/path")) : buildWorkspaceArchive({ git: gitLike, gitLarge: gitLike, scratchDir: scratch }, repoDir, commit));
    const step = createFreshVmCheck({
      port,
      archive,
      now: NOW,
      maxTimeoutMs: 24 * 3600_000,
      paths,
    });
    const base = { runId: "run-1", check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 30 }, repoDir: fx.repo, tip: fx.commit, baseFile: async () => null, networkPolicy: [{ host: "registry.example.test" }] as never };
    return { step, base, made, deleted, fx, port, archive, paths };
  }

  it("runs on the archive of the tip in a VM of its own (never the agent's), applies the agent's network rules, and the host reads the verdict; the VM is deleted after", async () => {
    const r = freshRig("echo checked-in-fresh\nexit 0\n");
    const outcome = await r.step(r.base);
    expect(outcome.passed).toBe(true);
    expect(outcome.body.summary).toContain("checked-in-fresh");
    expect(r.made.map((m) => m.name)).toEqual(["rc-run-1"]);
    expect(r.deleted).toEqual(["rc-run-1"]);
    expect(r.made[0]?.guest.sent.policies).toEqual([{ allow: ["registry.example.test"] }]);
    // the tree the check ran on is the tip's tree
    expect(execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: r.made[0]?.guest.paths.workspace, env: GIT_ENV(), encoding: "utf8" }).trim()).toBe(r.fx.tree);
  });

  it("in a VM the caller made: runs on the archive of the tip there, never creates or deletes a VM itself, and a VM it cannot reach ends closed", async () => {
    const r = freshRig("echo checked-in-given-vm\nexit 0\n");
    await r.port.createSandbox({ sandboxName: "rc-run-1", retention: { persistent: false }, timeoutMs: 1000 });
    const inVm = createCheckInVm({ port: r.port, archive: r.archive, now: NOW, paths: r.paths });
    const outcome = await inVm(r.base, { runId: "", sandboxName: "rc-run-1", sessionId: "" });
    expect(outcome.passed).toBe(true);
    expect(outcome.body.summary).toContain("checked-in-given-vm");
    expect(r.made).toHaveLength(1);
    expect(r.deleted).toEqual([]);
    expect(r.made[0]?.guest.sent.policies).toEqual([{ allow: ["registry.example.test"] }]);
    const missing = await inVm(r.base, { runId: "", sandboxName: "rc-other", sessionId: "" });
    expect(missing).toMatchObject({ passed: false, body: { reason: "sandbox_unavailable" } });
    expect(await createCheckInVm({ port: r.port, archive: async () => Promise.reject(new Error("/host/secret/path")), now: NOW })(r.base, { runId: "", sandboxName: "rc-run-1", sessionId: "" })).toMatchObject({ body: { reason: "start_failed" } });
  });

  it("a guest the agent had cannot make a check pass: a shim and a dotfile in the agent's VM change nothing, because the check never runs there", async () => {
    // the agent's VM: a `sh` shim that always says success, a poisoned dotfile, a background writer; the check, run for real, fails
    const agent = guestWith({ "scripts/check.sh": "exit 0\n", "bin/sh": { body: "#!/bin/sh\nexit 0\n", mode: 0o755 }, ".npmrc": "always-pass=true\n" });
    const r = freshRig("echo REAL-CHECK-FAILS\nexit 1\n");
    const outcome = await r.step(r.base);
    expect(outcome.passed).toBe(false);
    expect(outcome.body.exit_code).toBe(1);
    expect(outcome.body.summary).toContain("REAL-CHECK-FAILS");
    expect(agent.sent.commands).toEqual([]);
    expect(agent.sent.files).toEqual([]);
    expect(existsSync(path.join(r.made[0]?.guest.paths.workspace ?? "/nonexistent", ".npmrc"))).toBe(false);
  });

  it("a failing check, a time-out and a VM that cannot be made end closed and the VM that was made is deleted", async () => {
    const failing = freshRig("exit 3\n");
    expect((await failing.step(failing.base)).body.exit_code).toBe(3);
    expect(failing.deleted).toEqual(["rc-run-1"]);
    const slow = freshRig(`${BIN("sleep")} 30\n`);
    const timed = await slow.step({ ...slow.base, check: { ...slow.base.check, timeout_s: 1 } });
    expect(timed).toMatchObject({ passed: false, body: { exit_code: null, timed_out: true } });
    expect(slow.deleted).toEqual(["rc-run-1"]);
    const noVm = freshRig("exit 0\n", { createFails: true });
    const refused = await noVm.step(noVm.base);
    expect(refused).toMatchObject({ passed: false, body: { reason: "sandbox_unavailable", exit_code: null } });
    expect(refused.body.summary).not.toContain("/host/secret/path");
  }, 30_000);

  it("a tip that cannot be archived is start_failed and no VM is made; a dev shell is refused; a stop that came first runs nothing", async () => {
    const bad = freshRig("exit 0\n", { archiveFails: true });
    const outcome = await bad.step(bad.base);
    expect(outcome).toMatchObject({ passed: false, body: { reason: "start_failed" } });
    expect(outcome.body.summary).not.toContain("/host/secret/path");
    expect(bad.made).toEqual([]);
    const shell = freshRig("exit 0\n");
    expect((await shell.step({ ...shell.base, check: { ...shell.base.check, dev_shell: true } })).body.reason).toBe("sandbox_refused");
    const stop = new AbortController();
    stop.abort();
    expect((await shell.step({ ...shell.base, signal: stop.signal })).passed).toBe(false);
    expect(shell.made).toEqual([]);
  });
});
