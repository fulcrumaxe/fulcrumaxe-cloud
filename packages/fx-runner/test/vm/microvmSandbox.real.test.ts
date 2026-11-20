import { afterAll, beforeAll, describe } from "vitest";
import { createBootFactsSource } from "../../src/vm/bootFacts.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { createEgressPolicyPort } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk } from "../../src/vm/sandboxd/sdkAdapter.js";
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
  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: env.template as string, files: [{ kind: "kernel", arch, file: env.kernel as string }, { kind: "rootfs", arch, file: env.rootfs as string }, { kind: "agent", arch, file: env.agent as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: env.template as string, nodeArch: process.arch, readManifest: () => JSON.stringify({ [env.template as string]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: uid, platform: process.platform }, boot });
  });
  afterAll(async () => {
    await signed?.close();
  });
  describeEngineContract(
    "microVM engine (real VMs)",
    (runtime) => {
      const helper = createHelperClient(connectUnix(env.helper as string));
      const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
      const sdk = createDaemonSdk({ daemon: daemon as NonNullable<typeof daemon>, policy, template: env.template as string, memMb: 512 });
      const port = createMicrovmSandbox({ sdk, makeRuntime: () => runtime });
      return {
        port,
        env: () => ({}),
        workdir: "/work/job",
        timeoutMsOf: (handle) => port.timeoutMsOf(handle),
        interrupt: (handle) => port.interrupt(handle),
        lose: async () => {
          const id = daemon?.list()[0]?.name;
          if (id === undefined) throw new Error("no sandbox to lose");
          await sdk.deleteById(id);
        },
      };
    },
    MICROVM_DIFFERENCES,
  );
});
