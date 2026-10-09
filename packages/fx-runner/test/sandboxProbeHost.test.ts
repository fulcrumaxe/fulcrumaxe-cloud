import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeKit } from "../src/engines/claude/kit.js";
import { probeMachine } from "../src/sandbox/probe.js";
import { createSandboxHost } from "../src/sandbox/probeHost.js";
import { fakeSandboxHost } from "./helpers/fakeSandboxHost.js";

type Run = Parameters<typeof createSandboxHost>[0];
const noRun: Run = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the machine facts the probe is set up from", () => {
  it("no home directory, or a relative one, is a failure with a reason and starts nothing", async () => {
    for (const home of [undefined, "relative/home"]) {
      const host = fakeSandboxHost();
      const result = await probeMachine({ platform: "linux", home, stateDir: "/home/jane/.fx-runner", binaryPath: undefined }, host);
      expect(result).toEqual({ ok: false, reason: "probe_failed_other", detail: "the home directory is not known (HOME is not set)" });
      expect(host.calls).toEqual([]);
    }
  });
});

describe("the real host behind the probe", () => {
  it("reads a kernel setting with the system's own sysctl, by its dotted name, from fixed directories", async () => {
    const calls: Array<{ command: string; args: readonly string[]; env: Record<string, string> }> = [];
    const host = createSandboxHost(async (command, args, env) => {
      calls.push({ command, args, env });
      return { code: 0, stdout: "0\n", stderr: "", timedOut: false };
    });
    expect(await host.sysctl("user.max_user_namespaces")).toBe("0\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("sysctl");
    expect(calls[0]!.args).toEqual(["-n", "user.max_user_namespaces"]);
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["LC_ALL", "PATH"]);
  });

  it("a setting the machine does not have, or a name that is not a plain dotted word, answers undefined", async () => {
    const absent = createSandboxHost(async () => ({ code: 255, stdout: "", stderr: "cannot stat", timedOut: false }));
    expect(await absent.sysctl("kernel.unprivileged_userns_clone")).toBeUndefined();
    let started = 0;
    const host = createSandboxHost(async () => {
      started++;
      return { code: 0, stdout: "1", stderr: "", timedOut: false };
    });
    for (const bad of ["", "user", "../etc/passwd", "user.max; rm", "a.b.c.d.e", "User.Max", "user..max"]) expect(await host.sysctl(bad), bad).toBeUndefined();
    expect(started).toBe(0);
  });

  it("files and directories: a plain stat and a bounded read; a missing or oversized file reads as undefined", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fxr-probehost-"));
    writeFileSync(path.join(dir, "small.txt"), "ID=ubuntu\n");
    writeFileSync(path.join(dir, "big.txt"), "x".repeat(70 * 1024));
    const host = createSandboxHost(noRun);
    expect(host.isDir(dir)).toBe(true);
    expect(host.isFile(dir)).toBe(false);
    expect(host.isFile(path.join(dir, "small.txt"))).toBe(true);
    expect(host.readText(path.join(dir, "small.txt"))).toBe("ID=ubuntu\n");
    expect(host.readText(path.join(dir, "big.txt"))).toBeUndefined();
    expect(host.readText(path.join(dir, "missing.txt"))).toBeUndefined();
    expect(host.isDir(path.join(dir, "missing"))).toBe(false);
  });

  it("the engine kit's capture keeps a short piece of the error output, bounded, and the exit code", async () => {
    const kit = createClaudeKit(spawn);
    const out = await kit.captureWithStderr("/bin/sh", ["-c", "echo out; yes e | head -c 20000 >&2; exit 3"], { PATH: "/usr/bin:/bin" }, 5000);
    expect(out.code).toBe(3);
    expect(out.stdout).toBe("out\n");
    expect(out.stderr.length).toBeGreaterThan(0);
    expect(out.stderr.length).toBeLessThanOrEqual(4096);
    expect(out.timedOut).toBe(false);
    const plain = await kit.capture("/bin/sh", ["-c", "echo err >&2; echo out"], { PATH: "/usr/bin:/bin" }, 5000);
    expect(plain).toMatchObject({ code: 0, stdout: "out\n" });
  });
});
