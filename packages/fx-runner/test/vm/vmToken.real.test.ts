import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { ExecStream, type StreamItem } from "./helpers/agentClient.js";
import { bootVm, type Vm } from "./helpers/bootVm.js";

/**
 * D#587 B-6.4 against a REAL Firecracker booting the REAL root disk: the token goes in over vsock into the guest's tmpfs, a program that
 * holds it runs, and a snapshot taken after the wipe holds no byte of it (the memory file, the device-state file, the root disk and the
 * console log are all searched, for the whole sentinel and for its first 16 bytes). The same search of a snapshot taken WITHOUT the wipe
 * must find it: a search that cannot find a token that is there proves nothing. Needs the same three paths as vmBoot.real.test.ts
 * (FX_VM_FIRECRACKER, FX_VM_KERNEL, FX_VM_ROOTFS), runs as the ordinary user, and skips with a message without them.
 *
 * The sentinel is all random (hex), so its first 16 bytes cannot match a fixed string that is already in the guest, such as a token prefix
 * inside the agent CLI.
 */
const env = { firecracker: process.env["FX_VM_FIRECRACKER"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"] };
const ready = env.firecracker !== undefined && env.kernel !== undefined && env.rootfs !== undefined;
if (!ready) console.warn("vmToken.real: FX_VM_FIRECRACKER, FX_VM_KERNEL and FX_VM_ROOTFS are not all set; the real token checks are skipped");

const SECRET_DIR = "/run/fx-secret";

/** The offset of the first place `needle` is in the file, or -1; the file is read in pieces that overlap by the needle's length. */
function fileFind(file: string, needle: Buffer): number {
  const fd = openSync(file, "r");
  try {
    const piece = 8 << 20;
    const buf = Buffer.alloc(piece + needle.length);
    for (let at = 0, size = statSync(file).size; at < size; at += piece) {
      const n = readSync(fd, buf, 0, buf.length, at);
      const hit = buf.subarray(0, n).indexOf(needle);
      if (hit !== -1) return at + hit;
    }
    return -1;
  } finally {
    closeSync(fd);
  }
}

describe.skipIf(!ready)("the token and a snapshot, under a real Firecracker", () => {
  let work: string;
  const vms: Vm[] = [];
  beforeAll(() => {
    work = mkdtempSync(path.join(socketTmpRoot(), "fx-vm-token-"));
  });
  afterAll(async () => {
    for (const vm of vms) await vm.stop().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });
  const boot = async (name: string): Promise<Vm> => {
    const vm = await bootVm({ firecracker: env.firecracker!, kernel: env.kernel!, rootfs: env.rootfs! }, path.join(work, name), { memMib: 512, vcpus: 1, api: true });
    vms.push(vm);
    return vm;
  };
  const sentinelToken = (): Buffer => Buffer.from(randomBytes(32).toString("hex"));
  /** Delivers the token and starts a long-running stand-in for the agent CLI that holds it; resolves once it is running. */
  async function holder(vm: Vm, token: Buffer): Promise<ExecStream> {
    expect(await vm.agent.putToken(token)).toEqual({ ok: true });
    const stream = await ExecStream.open(vm.connect, { id: "cli", argv: ["sh", "-c", "echo $$ >/tmp/cli.pid; exec sleep 600"], token: true });
    for (let i = 0; i < 100; i++) {
      if ((await vm.agent.exec(["test", "-s", "/tmp/cli.pid"])).exit === 0) return stream;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the stand-in never started");
  }
  /** Every place a snapshot or the VM leaves bytes, searched for the whole token and for its first 16 bytes. */
  function leaks(vm: Vm, token: Buffer, snap: { state: string; mem: string }): string[] {
    const found: string[] = [];
    for (const [label, file] of Object.entries({ memory: snap.mem, state: snap.state, rootfs: vm.files.rootfs, console: vm.files.console })) {
      for (const [kind, needle] of [["whole", token], ["first 16 bytes", token.subarray(0, 16)]] as const) {
        const at = fileFind(file, needle);
        if (at === -1) continue;
        found.push(`${label}: ${kind}`);
        console.warn(`vmToken.real: ${label} (${file}) holds the ${kind} at offset 0x${at.toString(16)} (${at})`);
      }
    }
    return found;
  }
  /** What the guest kernel offers and what the agent has made, printed so that a run says why it failed or passed. */
  async function facts(vm: Vm, label: string): Promise<void> {
    const commands = [
      "uname -r",
      "cat /proc/self/cgroup",
      "grep -E ' cgroup2? ' /proc/self/mountinfo",
      "cat /sys/fs/cgroup/cgroup.controllers",
      "ls /sys/fs/cgroup/fx-token 2>&1",
      "for d in /sys/fs/cgroup/fx-token/*/; do echo $d; cat $d/cgroup.procs; done 2>&1",
      "ls -ld /run/fx-secret; grep -E ' /run/fx-secret ' /proc/self/mountinfo",
      "grep -E 'MemTotal|SwapTotal' /proc/meminfo",
    ];
    const out: string[] = [];
    for (const c of commands) {
      const r = await vm.agent.exec(["bash", "-c", c], { user: "root" });
      out.push(`$ ${c}\n${`${r.stdout}${r.stderr}`.trim()}`);
    }
    console.warn(`vmToken.real facts (${label}):\n${out.join("\n")}`);
  }
  const snap = (name: string): { state: string; mem: string } => {
    mkdirSync(path.join(work, name), { recursive: true });
    return { state: path.join(work, name, "vm.state"), mem: path.join(work, name, "vm.mem") };
  };

  it("control: a snapshot taken while a program still holds the token DOES contain it, so the search below can see a token that is there", async () => {
    const vm = await boot("control");
    const token = sentinelToken();
    await holder(vm, token);
    const files = snap("control-snap");
    await vm.snapshot(files.state, files.mem);
    expect(leaks(vm, token, files)).toContain("memory: whole");
    rmSync(path.dirname(files.mem), { recursive: true, force: true });
  }, 180_000);

  it("after delivery, launch and the wipe, no snapshot file, disk file or log holds the token or its first 16 bytes", async () => {
    const vm = await boot("wiped");
    const token = sentinelToken();
    const stream = await holder(vm, token);
    await facts(vm, "wiped test, holder running");
    const pid = (await vm.agent.exec(["cat", "/tmp/cli.pid"])).stdout.trim();
    // the guest holds it where it should: the program's environment, nowhere else we can read, and the file is gone after the launch
    expect((await vm.agent.exec(["ls", SECRET_DIR], { user: "root" })).stdout).toBe("");
    // the stream is read from the moment it exists, as a real caller reads it, and each frame's arrival is timed against the wipe
    const frames: string[] = [];
    let wipedAt = 0;
    const reading = (async (): Promise<StreamItem[]> => {
      const items: StreamItem[] = [];
      try {
        for (let e = await stream.next(); e !== null; e = await stream.next()) {
          items.push(e);
          frames.push(`${e.ev}@${wipedAt === 0 ? "before the wipe" : `+${Date.now() - wipedAt}ms`}`);
          if (e.ev === "exit") break;
        }
      } finally {
        stream.socket.destroy();
      }
      return items;
    })();
    const wiped = await vm.agent.wipeToken();
    wipedAt = Date.now();
    console.warn(`vmToken.real: the wipe answered ${JSON.stringify(wiped)}`);
    // the holder's launch consumed the file (its name is unlinked at the launch, which the empty listing above shows), so the wipe has no file to remove
    expect(wiped).toMatchObject({ ok: true, removed: false, killed: 1 });
    expect((await vm.agent.exec(["test", "-d", `/proc/${pid}`])).exit).not.toBe(0);
    // the agent's record of the command, which it makes only once it has finished the stream's command
    console.warn(`vmToken.real: the agent's record of the command: ${JSON.stringify(await vm.agent.kill("cli"))} (${Date.now() - wipedAt}ms after the wipe)`);
    await facts(vm, "wiped test, after the wipe");
    const ended = await reading;
    // what the stream said, and the guest's own console (agent tracebacks go there), so a missing exit frame explains itself
    const said = ended.map((i: StreamItem) => (i.ev === "error" ? { ev: i.ev, header: i.header } : i.ev === "exit" ? { ev: i.ev, exit: i.exit, signal: i.signal, timed_out: i.timed_out } : { ev: i.ev }));
    console.warn(`vmToken.real: the held stream said ${JSON.stringify(said)} (${frames.join(", ")})\nconsole tail:\n${vm.console().slice(-3000)}`);
    expect(said,"the killed holder's stream ends with its exit frame and the signal that killed it").toEqual([{ ev: "exit", exit: null, signal: 9, timed_out: false }]);
    // not on the kernel command line, not in PID 1's environment
    expect((await vm.agent.exec(["cat", "/proc/cmdline"])).stdout).not.toContain(token.toString().slice(0, 16));
    expect((await vm.agent.exec(["cat", "/proc/1/environ"], { user: "root" })).stdout).not.toContain(token.toString().slice(0, 16));
    const files = snap("wiped-snap");
    await vm.snapshot(files.state, files.mem);
    expect(leaks(vm, token, files)).toEqual([]);
    rmSync(path.dirname(files.mem), { recursive: true, force: true });
  }, 180_000);

  it("the secret directory is root's 0700 tmpfs, the ordinary user cannot list it or read the file, and the Bash sandbox's PID namespace hides the holder's environment", async () => {
    const vm = await boot("canary");
    await facts(vm, "canary test, at boot");
    const mounts = (await vm.agent.exec(["cat", "/proc/self/mountinfo"])).stdout;
    expect(mounts).toMatch(new RegExp(`${SECRET_DIR} .* - tmpfs tmpfs .*mode=700`));
    expect((await vm.agent.exec(["stat", "-c", "%U %a", SECRET_DIR], { user: "root" })).stdout).toBe("root 700\n");
    const token = sentinelToken();
    expect(await vm.agent.putToken(token)).toEqual({ ok: true });
    // before any launch the file exists, and the ordinary user (the user Bash runs as) cannot reach it
    expect((await vm.agent.exec(["cat", `${SECRET_DIR}/oauth-token`], { user: "ubuntu" })).exit).not.toBe(0);
    expect((await vm.agent.exec(["ls", SECRET_DIR], { user: "ubuntu" })).exit).not.toBe(0);
    await vm.agent.wipeToken();
    const stream = await holder(vm, token);
    const needle = token.toString().slice(0, 16);
    // A = how many environments carry the holder's token; B = how many carry a marker that is set INSIDE the sandbox (the positive control: the
    // same search over the same /proc does find an environment that is there, so an empty A means "not visible" and not "the search ran nowhere")
    const marker = randomBytes(8).toString("hex");
    const scan = `echo A=$(grep -l ${needle} /proc/[0-9]*/environ 2>/dev/null | wc -l); echo B=$(grep -l ${marker} /proc/[0-9]*/environ 2>/dev/null | wc -l)`;
    const counts = (out: string): { a: number; b: number } => ({ a: Number(/A=(\d+)/.exec(out)?.[1]), b: Number(/B=(\d+)/.exec(out)?.[1]) });
    // control: the same search from an ordinary shell finds the holder's environment
    const outside = await vm.agent.exec(["env", `FXMARK=${marker}`, "bash", "-c", scan], { user: "ubuntu" });
    expect(outside.exit).toBe(0);
    expect(counts(outside.stdout).a).toBeGreaterThanOrEqual(1);
    // the Bash sandbox's own bwrap supports a PID namespace, runs as the ordinary user, and inside it the holder's environment is not there
    expect((await vm.agent.exec(["bash", "-c", "bwrap --help 2>&1 | grep -c -- --unshare-pid"])).stdout.trim()).not.toBe("0");
    const inside = await vm.agent.exec(["bwrap", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--setenv", "FXMARK", marker, "bash", "-c", scan], { user: "ubuntu" });
    expect(inside.exit, inside.stderr).toBe(0);
    expect(counts(inside.stdout), "the control sees its own environment, the holder's is not visible").toMatchObject({ a: 0 });
    expect(counts(inside.stdout).b).toBeGreaterThanOrEqual(1);
    // bwrap with no PID namespace is reported, not asserted: it makes its own user namespace, and a process in a child user namespace may be
    // refused another process's environ for that reason alone (the run of 11-19 saw A=0 here), so it is not a control for --unshare-pid
    const without = await vm.agent.exec(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--setenv", "FXMARK", marker, "bash", "-c", scan], { user: "ubuntu" });
    console.warn(`vmToken.real: bwrap without --unshare-pid: exit ${without.exit}, ${without.stdout.trim().replace(/\n/g, " ")} ${without.stderr.trim()}`);
    await vm.agent.wipeToken();
    await stream.untilExit();
  }, 180_000);
});
