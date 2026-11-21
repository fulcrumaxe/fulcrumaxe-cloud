import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";
import { createBootFactsSource } from "../../src/vm/bootFacts.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { createEgressPolicyPort } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk, sandboxIdOf } from "../../src/vm/sandboxd/sdkAdapter.js";
import { connectUnix } from "./sandboxd/helpers.js";
import { describeEngineContract, type Difference } from "../sandbox/engineContract.js";

/**
 * D#587 B-5a: the engine suite (`test/sandbox/engineContract.ts`) against REAL VMs. It builds what a runner builds: the production daemon (real fd
 * inspection, real helper client), the real egress policy port with the real proxy and reverse endpoint, and `createMicrovmSandbox` on top. Only the
 * agent runtime is the suite's scripted one, because the guest's agent image rows come later.
 *
 * It needs, in the environment (a dispatched host that has Firecracker, the helper and a built guest image sets them; anywhere else the suite says so
 * and skips):
 *   FX_VM_HELPER_SOCKET   the root helper's Unix socket
 *   FX_VM_TEMPLATE        the template name the daemon creates sandboxes from
 *   FX_VM_KERNEL, FX_VM_ROOTFS, FX_VM_AGENT   the three disks the dispatched run built and installed for that template
 * The boot facts are the production source (`createBootFactsSource`) over a signed TEST release of those disks, made here with throwaway keys and a test root and
 * served over TLS to the real TUF client; the installed manifest is the pair of digests of the same two files. The production root is never used, and nothing
 * here is a way to boot an unsigned image: the gate still checks the listing.
 * It runs as the ordinary user, never as root. Not run in the unit job; running it on a dispatched host is a separate step.
 */
const env = { helper: process.env["FX_VM_HELPER_SOCKET"], template: process.env["FX_VM_TEMPLATE"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"], agent: process.env["FX_VM_AGENT"] };
const ready = env.helper !== undefined && env.template !== undefined && env.kernel !== undefined && env.rootfs !== undefined && env.agent !== undefined && process.geteuid !== undefined && process.geteuid() !== 0;
if (!ready) console.warn("microvmSandbox.real: FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE, FX_VM_KERNEL, FX_VM_ROOTFS and FX_VM_AGENT are not all set (or this is root); the real-VM engine suite is skipped");

/** The same differences as the daemon-fake subject: the VM is real, the behaviour the port promises is not. */
const MICROVM_DIFFERENCES: ReadonlySet<Difference> = new Set<Difference>(["publishCalls", "idleState", "usageFigures", "lossShape", "jobEnv"]);

describe.skipIf(!ready)("microVM engine (real VMs, the production daemon and the real egress policy port)", () => {
  const uid = process.geteuid?.() ?? -1;
  let daemon: ReturnType<typeof createProductionSandboxd> | undefined;
  let signed: SignedRelease | undefined;
  // The helper holds a fixed number of sandboxes at once (`over_cap` past it): the contract tests leave theirs behind, so each test's are deleted after it.
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const clean of cleanups.splice(0)) await clean().catch(() => undefined);
  });
  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: env.template as string, files: [{ kind: "kernel", arch, file: env.kernel as string }, { kind: "rootfs", arch, file: env.rootfs as string }, { kind: "agent", arch, file: env.agent as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: env.template as string, nodeArch: process.arch, readManifest: () => JSON.stringify({ [env.template as string]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: uid, platform: process.platform }, boot });
  });
  // Every sandbox this file made, by the daemon id the helper lists it under. The cleanups above swallow a failed delete so one test's leftover cannot
  // fail the next; this is where that failure is reported, as what it is, instead of as `over_cap` in some later test.
  const madeIds = new Set<string>();
  afterAll(async () => {
    try {
      const left = (await createHelperClient(connectUnix(env.helper as string)).list()).map((e) => e.sandboxId).filter((id) => madeIds.has(id));
      expect(left, "sandboxes this file created are still held by the helper (a delete failed)").toEqual([]);
      expect(daemon?.list().map((row) => row.name) ?? [], "the daemon still lists sandboxes this file created").toEqual([]);
    } finally {
      await signed?.close();
    }
  });
  describeEngineContract(
    "microVM engine (real VMs)",
    (runtime) => {
      const helper = createHelperClient(connectUnix(env.helper as string));
      const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
      const sdk = createDaemonSdk({ daemon: daemon as NonNullable<typeof daemon>, policy, template: env.template as string, memMb: 512 });
      const port = createMicrovmSandbox({ sdk, makeRuntime: () => runtime });
      const made = port.createSandbox.bind(port);
      port.createSandbox = async (opts) => {
        const handle = await made(opts);
        madeIds.add(sandboxIdOf(handle.sandboxName));
        cleanups.push(() => port.deleteSandbox(handle));
        return handle;
      };
      return {
        port,
        env: () => ({}),
        workdir: "/work/job",
        timeoutMsOf: (handle) => port.timeoutMsOf(handle),
        interrupt: (handle) => port.interrupt(handle),
        // The daemon here is shared by every test in the file and earlier tests leave sandboxes in it, so "the first one listed" is not the one the test made.
        lose: async (handle) => sdk.deleteById(sandboxIdOf(handle.sandboxName)),
        guestFile: async (handle, file) => {
          const ran = await port.runCommand(handle, { role: "plane_publish", cmd: "sh", args: ["-c", "stat -c %a -- \"$1\" && cat -- \"$1\"", "sh", file], env: {}, networkPolicy: [], timeoutMs: 20_000 });
          if (ran.exitCode !== 0) return undefined;
          const split = ran.stdout.indexOf("\n");
          return { mode: Number.parseInt(ran.stdout.slice(0, split), 8), data: Buffer.from(ran.stdout.slice(split + 1), "utf8") };
        },
      };
    },
    MICROVM_DIFFERENCES,
  );
});
