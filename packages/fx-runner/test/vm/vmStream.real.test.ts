import { mkdtempSync, rmSync } from "node:fs";
import type { Duplex } from "node:stream";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { createGuestAgent, viaFirecrackerVsock, type GuestAgent } from "../../src/vm/sandboxd/guestAgent.js";
import type { GuestStream, StreamFrame } from "../../src/vm/sandboxd/streamCommand.js";
import { bootVm, type Vm } from "./helpers/bootVm.js";

/**
 * D#587 B-5a-RT-1 against a REAL Firecracker booting the REAL root disk: the production client's streaming exec and kill over real vsock and
 * Firecracker's UDS proxy. Needs the same three paths as vmBoot.real.test.ts (FX_VM_FIRECRACKER, FX_VM_KERNEL, FX_VM_ROOTFS), runs as the ordinary
 * user, and skips with a message without them. Not run in the unit job; the dispatched microvm-image run covers it.
 */
const env = { firecracker: process.env["FX_VM_FIRECRACKER"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"] };
const ready = env.firecracker !== undefined && env.kernel !== undefined && env.rootfs !== undefined;
if (!ready) console.warn("vmStream.real: FX_VM_FIRECRACKER, FX_VM_KERNEL and FX_VM_ROOTFS are not all set; the real streaming checks are skipped");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const text = (frames: StreamFrame[]): string => Buffer.concat(frames.map((f) => f.data)).toString();

describe.skipIf(!ready)("the production streaming exec and kill, under a real Firecracker", () => {
  let work: string;
  let vm: Vm;
  let guest: GuestAgent;
  const sockets: Duplex[] = []; // every connection the client opened, so a case can look at what the host itself is holding
  beforeAll(async () => {
    work = mkdtempSync(path.join(socketTmpRoot(), "fx-vm-stream-"));
    vm = await bootVm({ firecracker: env.firecracker!, kernel: env.kernel!, rootfs: env.rootfs! }, path.join(work, "vm"), { memMib: 512, vcpus: 1 });
    const connect = viaFirecrackerVsock(path.join(work, "vm", "v.sock"));
    guest = createGuestAgent(async () => {
      const socket = await connect();
      sockets.push(socket);
      return socket;
    }, 20_000);
  }, 180_000);
  afterAll(async () => {
    await vm?.stop().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  it("40 MiB over two streams arrives in full and in order within each stream, and the host holds a few chunks of its own, not the stream", async () => {
    const total = 20 << 20;
    const script = `yes AAAAAAAAA | head -c ${total} & yes BBBBBBBBB | head -c ${total} >&2 & wait`;
    const stream = await guest.streamInGuest({ id: "big-1", argv: ["sh", "-c", script], timeoutS: 120 });
    const seen = { stdout: 0, stderr: 0 };
    let wrong = 0;
    let n = 0;
    const socket = sockets[sockets.length - 1]!; // the stream's own connection (the capability ping used an earlier one)
    let peak = 0; // the most bytes the host's socket ever held unread
    for await (const f of stream.frames) {
      const letter = f.stream === "stdout" ? 0x41 : 0x42;
      for (let i = 0; i < f.data.length; i++) {
        const at = seen[f.stream] + i;
        if (f.data[i] !== (at % 10 === 9 ? 0x0a : letter)) wrong++;
      }
      seen[f.stream] += f.data.length;
      if (++n < 200) await sleep(5); // a consumer slower than the guest for a while: the guest's pipe stalls, the host's memory does not grow
      peak = Math.max(peak, socket.readableLength);
    }
    expect(seen).toEqual({ stdout: total, stderr: total });
    expect(wrong).toBe(0);
    expect(peak, "bytes the host buffered at once").toBeLessThanOrEqual(256 << 10); // one frame is at most 64 KiB plus its header
    expect(await stream.done).toMatchObject({ exit: 0, signal: null, timedOut: false });
  }, 180_000);

  it("kill(SIGINT) is delivered to a child that traps it, and the child's own handler ends the command", async () => {
    const stream: GuestStream = await guest.streamInGuest({ id: "int-1", argv: ["sh", "-c", "trap 'echo got-int; exit 7' INT; echo ready; while :; do sleep 0.05; done"] });
    const it = stream.frames[Symbol.asyncIterator]();
    expect(text([(await it.next()).value as StreamFrame])).toBe("ready\n");
    await stream.kill("SIGINT");
    const rest: StreamFrame[] = [];
    for (let r = await it.next(); r.done !== true; r = await it.next()) rest.push(r.value);
    expect(text(rest)).toContain("got-int");
    expect(await stream.done).toMatchObject({ exit: 7, signal: null });
  }, 60_000);

  it("kill(SIGKILL) ends a command whose descendant left its group with setsid, and the exit frame carries signal 9, not an exit code", async () => {
    const script = "setsid sh -c 'echo $$ > /tmp/esc.pid; while :; do printf x 2>/dev/null; sleep 0.1; done' & wait";
    const stream = await guest.streamInGuest({ id: "esc-1", argv: ["sh", "-c", script], timeoutS: 120 });
    const reading = (async (): Promise<void> => {
      for await (const frame of stream.frames) void frame;
    })();
    await sleep(1500);
    await stream.kill("SIGKILL");
    await reading;
    expect(await stream.done).toMatchObject({ exit: null, signal: 9, timedOut: false });
    await sleep(500);
    const probe = await guest.streamInGuest({ id: "esc-probe", argv: ["sh", "-c", "kill -0 $(cat /tmp/esc.pid) 2>/dev/null && echo alive || echo gone"] });
    const frames: StreamFrame[] = [];
    for await (const f of probe.frames) frames.push(f);
    expect(text(frames).trim()).toBe("gone");
  }, 120_000);

  it("the image's agent advertises the streaming ops this client needs (a plain command runs through it)", async () => {
    const stream = await guest.streamInGuest({ id: "caps-1", argv: ["true"] });
    for await (const frame of stream.frames) void frame;
    expect(await stream.done).toMatchObject({ exit: 0 });
  }, 60_000);
});
