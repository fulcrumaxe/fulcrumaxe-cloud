import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_CLAUDE_VERSION } from "../../src/engines/claude/pin.js";
import { bootVm, type Vm } from "./helpers/bootVm.js";
import { guestClaudeBinary } from "./helpers/guestClaude.js";

/**
 * D#587 B-1 acceptance 3 to 7, against a REAL Firecracker booting the REAL root disk that `fx-runner vm build-image` made. It needs
 * three paths in the environment (the hosted probe workflow sets them; on a machine without them the suite says so and skips):
 *   FX_VM_FIRECRACKER  the pinned firecracker binary    FX_VM_KERNEL  the pinned guest kernel    FX_VM_ROOTFS  the root disk
 * It runs as the ordinary user: no jailer, no root, no network device. KVM must be usable by that user.
 */
const env = { firecracker: process.env["FX_VM_FIRECRACKER"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"] };
const ready = env.firecracker !== undefined && env.kernel !== undefined && env.rootfs !== undefined;
if (!ready) console.warn("vmBoot.real: FX_VM_FIRECRACKER, FX_VM_KERNEL and FX_VM_ROOTFS are not all set; the real boot checks are skipped");

describe.skipIf(!ready)("the fx-agent guest, booted under Firecracker", () => {
  let vm: Vm;
  let work: string;
  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), "fx-vm-boot-"));
    vm = await bootVm({ firecracker: env.firecracker!, kernel: env.kernel!, rootfs: env.rootfs! }, path.join(work, "vm"));
    console.warn(`vmBoot.real: first agent answer ${vm.bootMs} ms after spawn`);
  }, 90_000);
  afterAll(async () => {
    await vm?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  it("5. the agent answers, and `echo ok` returns ok with exit 0", async () => {
    expect(await vm.agent.ping()).toMatchObject({ ok: true, proto: 1 });
    expect(await vm.agent.exec(["echo", "ok"])).toMatchObject({ exit: 0, stdout: "ok\n" });
    const bad = await vm.agent.exec(["sh", "-c", "echo to-err >&2; exit 7"]);
    expect(bad).toMatchObject({ exit: 7, stderr: "to-err\n" });
  });

  it("5. put and get round-trip bytes, and counters report the machine", async () => {
    const data = randomBytes(1 << 20);
    await vm.agent.put("/tmp/blob.bin", data, 0o600);
    expect(Buffer.compare(await vm.agent.get("/tmp/blob.bin"), data)).toBe(0);
    expect((await vm.agent.exec(["stat", "-c", "%U %a", "/tmp/blob.bin"])).stdout).toBe("ubuntu 600\n");
    const c = (await vm.agent.counters()) as { uptime_s: number; mem_kb: { MemTotal: number }; agent: { exec: number } };
    expect(c.uptime_s).toBeGreaterThan(0);
    expect(c.mem_kb.MemTotal).toBeGreaterThan(500_000);
    expect(c.agent.exec).toBeGreaterThan(0);
  });

  it("3. /proc, /sys, /dev, the /dev/fd links, /etc/hosts and loopback are set up", async () => {
    const sh = async (script: string) => vm.agent.exec(["bash", "-c", script]);
    expect(await sh("mountpoint -q /proc && mountpoint -q /sys && mountpoint -q /dev && echo mounted")).toMatchObject({ exit: 0, stdout: "mounted\n" });
    const hosts = await vm.agent.exec(["getent", "hosts", "localhost"]);
    expect(hosts.exit).toBe(0);
    expect(hosts.stdout).toMatch(/localhost/);
    const fd = await vm.agent.exec(["ls", "-l", "/dev/fd/"]);
    expect(fd.exit).toBe(0);
    expect(fd.stdout).toMatch(/ 0 -> /);
    expect((await vm.agent.exec(["readlink", "/dev/fd"])).stdout).toBe("/proc/self/fd\n");
    const lo = await vm.agent.exec(["ip", "-o", "link", "show", "lo"]);
    expect(lo.exit).toBe(0);
    expect(lo.stdout).toMatch(/<LOOPBACK,UP,LOWER_UP>/);
    expect((await sh("cat <(echo process-substitution-works)")).stdout).toBe("process-substitution-works\n");
  });

  it("4. `ip -o link` lists only lo: the guest has no network device", async () => {
    const links = await vm.agent.exec(["ip", "-o", "link"]);
    expect(links.exit).toBe(0);
    const names = links.stdout.trim().split("\n").map((l) => l.split(": ")[1]);
    expect(names).toEqual(["lo"]);
    expect(((await vm.agent.counters()) as { nics: string[] }).nics).toEqual(["lo"]);
  });

  it("6. pnpm, psql, python3, jq and bwrap are on PATH, the kernel has USER_NS and bwrap runs", async () => {
    expect((await vm.agent.exec(["which", "pnpm", "psql", "python3", "jq", "bwrap"])).exit).toBe(0);
    expect((await vm.agent.exec(["bash", "-c", "zcat /proc/config.gz | grep -x CONFIG_USER_NS=y"])).exit).toBe(0);
    expect((await vm.agent.exec(["bwrap", "--version"])).exit).toBe(0);
    const sandboxed = await vm.agent.exec(["bwrap", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "bash", "-c", "echo pid=$$"]);
    expect(sandboxed.exit).toBe(0);
    // bwrap is PID 1 of the new namespace and its child is PID 2; on the guest's own namespace the shell would have a large PID
    expect(sandboxed.stdout).toMatch(/^pid=[12]\n$/);
    expect((await vm.agent.exec(["pnpm", "--version"])).stdout.trim()).toMatch(/^11\.\d+\.\d+$/);
  });

  it("7. the guest's claude passes C19's version and capability checks through ClaudeBinary", async () => {
    const binary = await guestClaudeBinary(vm.agent);
    expect(binary.path).toBe("/opt/fx/bin/claude");
    const [a, b, c] = binary.version.split(".").map(Number);
    const [x, y, z] = MIN_CLAUDE_VERSION.split(".").map(Number);
    expect([a, b, c]).not.toEqual([0, 0, 0]);
    expect(a! * 1e12 + b! * 1e6 + c!).toBeGreaterThanOrEqual(x! * 1e12 + y! * 1e6 + z!);
  }, 120_000);

  it("the machine stops when the agent ends: nothing is left running to serve", async () => {
    const second = await bootVm({ firecracker: env.firecracker!, kernel: env.kernel!, rootfs: env.rootfs! }, path.join(work, "vm2"), { memMib: 512, vcpus: 1 });
    try {
      expect(await second.exitedWithin(300)).toBe(false);
      // the agent is killed while it serves this very request, so no reply comes back
      await second.agent.exec(["pkill", "-f", "usr/lib/fx/agent.py"], { user: "root" }).catch(() => undefined);
      expect(await second.exitedWithin(10_000), second.console().slice(-800)).toBe(true);
    } finally {
      await second.stop();
    }
  });

  it("the root disk is read-only, the kernel wipes freed memory, and there is no swap", async () => {
    expect((await vm.agent.exec(["touch", "/usr/x"], { user: "root" })).exit).not.toBe(0);
    expect((await vm.agent.exec(["cat", "/proc/cmdline"])).stdout).toMatch(/\binit_on_free=1\b/);
    expect(((await vm.agent.counters()) as { mem_kb: { SwapTotal: number } }).mem_kb.SwapTotal).toBe(0);
  });
});
