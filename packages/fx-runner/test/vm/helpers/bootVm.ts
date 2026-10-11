import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentClient, viaFirecrackerVsock } from "./agentClient.js";

/**
 * Boots the fx-agent root disk under a real Firecracker, no jailer and no root (the jailer is B-2a). Test tooling for B-1: it is the
 * probe the hosted-CI workflow and the local run share. There is no network device in the configuration, so the guest has none.
 */
export interface BootEnv {
  firecracker: string;
  kernel: string;
  rootfs: string;
}

export interface Vm {
  agent: AgentClient;
  console(): string;
  bootMs: number;
  /** Resolves true when the Firecracker process has exited, false if it is still running after `ms`. */
  exitedWithin(ms: number): Promise<boolean>;
  stop(): Promise<void>;
}

/** The cmdline: read-only ext4 root, our init, wipe freed memory (D#587 §1.5), a machine that stops instead of hanging. */
export const CMDLINE = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro rootfstype=ext4 init=/usr/lib/fx/init init_on_free=1 random.trust_cpu=on";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function bootVm(env: BootEnv, dir: string, opts: { memMib?: number; vcpus?: number } = {}): Promise<Vm> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const uds = path.join(dir, "v.sock");
  const log = path.join(dir, "console.log");
  const config = {
    "boot-source": { kernel_image_path: env.kernel, boot_args: CMDLINE },
    drives: [{ drive_id: "rootfs", path_on_host: env.rootfs, is_root_device: true, is_read_only: true }],
    "machine-config": { vcpu_count: opts.vcpus ?? 2, mem_size_mib: opts.memMib ?? 1024 },
    vsock: { guest_cid: 3, uds_path: uds },
  };
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const out = openSync(log, "w");
  const started = Date.now();
  const child: ChildProcess = spawn(env.firecracker, ["--no-api", "--config-file", path.join(dir, "config.json")], { stdio: ["ignore", out, out] });
  const agent = new AgentClient(viaFirecrackerVsock(uds));
  const text = (): string => readFileSync(log, "utf8");
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const stop = async (): Promise<void> => {
    if (!exited) child.kill("SIGKILL");
    while (!exited) await sleep(20);
  };
  for (;;) {
    if (exited) throw new Error(`firecracker exited before the agent answered:\n${text().slice(-12_000)}`);
    if (Date.now() - started > 60_000) {
      await stop();
      throw new Error(`no answer from the agent in 60 s:\n${text().slice(-12_000)}`);
    }
    try {
      await agent.ping();
      const exitedWithin = async (ms: number): Promise<boolean> => {
        for (const until = Date.now() + ms; !exited && Date.now() < until; ) await sleep(20);
        return exited;
      };
      return { agent, console: text, bootMs: Date.now() - started, exitedWithin, stop };
    } catch {
      await sleep(25);
    }
  }
}
