import { randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { engineSessionPolicy } from "../../src/engineSession/sessionPolicy.js";
import { createBootFactsSource } from "../../src/vm/bootFacts.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { TEMPLATES } from "../../src/vm/lock.js";
import { GuestBindings } from "../../src/vm/sandboxd/guestBindings.js";
import { guestEnvOf } from "../../src/vm/sandboxd/guestEnv.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { createEgressPolicyPort } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk, sandboxIdOf } from "../../src/vm/sandboxd/sdkAdapter.js";
import { createMicrovmVmPort } from "../../src/vm/sandboxd/vmPort.js";
import { tempDir } from "../helpers/tempTree.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#845 ON-13a1 against a REAL microVM, two things the fakes cannot show:
 *  1. B-3 through the production VM factory: a persistent session VM keeps a file across stop (snapshot) and `resume`, and after `delete` neither the sandbox nor its snapshots are left.
 *  2. The `engine_session` egress template on the real proxy and reverse relay, from a program INSIDE the guest: `git ls-remote` of a public repository and `api.github.com` succeed, the cloud's origin and
 *     `uploads.github.com` are refused by the proxy. This part reaches the public network (and the guest-side relays of #1161 and #1162), so it also needs FX_VM_PUBLIC_NET=1.
 * Same environment as `vmRelays.real.test.ts` (a dispatched `microvm-image.yml` host); anywhere else the suite says so and skips. Ordinary user, never root.
 */
const env = { helper: process.env["FX_VM_HELPER_SOCKET"], template: process.env["FX_VM_TEMPLATE"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"], agent: process.env["FX_VM_AGENT"], net: process.env["FX_VM_PUBLIC_NET"] === "1" };
const ready = env.helper !== undefined && env.template === TEMPLATES[0] && env.kernel !== undefined && env.rootfs !== undefined && env.agent !== undefined && process.geteuid !== undefined && process.geteuid() !== 0;
if (!ready) console.warn("engineSession.real: FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE, FX_VM_KERNEL, FX_VM_ROOTFS and FX_VM_AGENT are not all set (or this is root); the real-VM engine session suite is skipped");

const CLOUD_ORIGIN_HOST = "cloud.fulcrum-fixture.test";
const PUBLIC_REPO = "https://github.com/octocat/Hello-World.git";
const PROBE = `import json, subprocess, urllib.request
def get(url):
    try:
        return {"status": "ok", "body": urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "fx-session-probe"}), timeout=60).read(200).decode()}
    except Exception as error:
        return {"status": "refused", "body": str(error)[:200]}
def git(url):
    out = subprocess.run(["git", "ls-remote", url, "HEAD"], capture_output=True, text=True, timeout=90)
    return {"status": "exit %d" % out.returncode, "body": out.stdout.strip()[:100]}
print(json.dumps({"git": git("${PUBLIC_REPO}"), "zen": get("https://api.github.com/zen"), "cloud": get("https://${CLOUD_ORIGIN_HOST}/"), "uploads": get("https://uploads.github.com/")}))
`;

describe.skipIf(!ready)("an engine session's VM, real (persistence through the production VM factory)", () => {
  const uid = process.geteuid?.() ?? -1;
  let signed: SignedRelease | undefined;
  let daemon: ReturnType<typeof createProductionSandboxd>;
  let port: ReturnType<typeof createMicrovmSandbox>;
  let vmPort: ReturnType<typeof createMicrovmVmPort>;
  let sdk: ReturnType<typeof createDaemonSdk>;
  const made: string[] = [];
  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: env.kernel as string }, { kind: "rootfs", arch, file: env.rootfs as string }, { kind: "agent", arch, file: env.agent as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: TEMPLATES[0], nodeArch: process.arch, readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    const snapshotDir = tempDir("fx-session-snaps-");
    const free = (dir: string): number | undefined => {
      const stats = statfsSync(dir);
      return stats.bavail * stats.bsize;
    };
    daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: uid, platform: process.platform }, boot, snapshots: { dir: snapshotDir, quotaBytes: 8 * 1024 ** 3, freeBytes: free, stateDir: path.join(tempDir("fx-session-state-"), "sandboxd") } });
    const helper = createHelperClient(connectUnix(env.helper as string));
    const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
    sdk = createDaemonSdk({ daemon, policy, template: TEMPLATES[0], memMb: 512 });
    port = createMicrovmSandbox({ sdk, makeRuntime: () => { throw new Error("a session lifecycle starts no agent"); } });
    vmPort = createMicrovmVmPort({ sandbox: port, daemon, bindings: new GuestBindings(), policy, idOf: sandboxIdOf, timeoutMs: 30 * 60_000, persistent: true });
  }, 120_000);
  afterEach(async () => {
    for (const name of made.splice(0)) await vmPort.delete(name).catch(() => undefined); // fx-swallow-ok: a sandbox the daemon no longer holds is the wanted state
  });
  afterAll(async () => {
    await signed?.close();
  });
  const handleOf = (name: string) => ({ runId: "", sandboxName: name, sessionId: "" });
  const listed = async (name: string): Promise<boolean> => (await sdk.list?.({ namePrefix: name, teamId: "local", projectId: "local", token: "local" }))?.sandboxes.some((s) => s.name === name) ?? false;

  it("B-3: a file written before the stop is still there after resume, and after delete the sandbox and its snapshots are gone", async () => {
    const name = `fx-engine-${randomBytes(4).toString("hex")}`;
    made.push(name);
    await vmPort.create(name, "agent");
    await vmPort.startEgress(name);
    await vmPort.waitGuest(name, new AbortController().signal);
    const first = await port.guestOf(handleOf(name));
    await first.writeFiles([{ path: "/vercel/sandbox/kept-by-b3.txt", content: "written before the stop\n" }]);
    await vmPort.stop(name); // a persistent VM keeps a snapshot
    expect(await port.sandboxState?.(handleOf(name))).toBe("stopped");
    await vmPort.resume(name);
    const woken = await port.guestOf(handleOf(name));
    const cat = await woken.runCommand({ cmd: "cat", args: ["/vercel/sandbox/kept-by-b3.txt"], detached: true });
    let out = "";
    for await (const log of cat.logs()) if (log.stream === "stdout") out += typeof log.data === "string" ? log.data : Buffer.from(log.data as Uint8Array).toString("utf8");
    expect((await cat.wait()).exitCode).toBe(0);
    expect(out).toBe("written before the stop\n");
    await vmPort.stop(name);
    await vmPort.delete(name);
    expect(await port.sandboxState?.(handleOf(name))).toBe("gone");
    expect(await listed(name)).toBe(false);
  }, 600_000);

  it.skipIf(!env.net)("egress: from inside an engine_session guest, git ls-remote of a public repository and api.github.com succeed; the cloud origin and uploads.github.com are refused by the proxy", async () => {
    const name = `fx-engine-${randomBytes(4).toString("hex")}`;
    made.push(name);
    await vmPort.create(name, "agent");
    const guest = await port.guestOf(handleOf(name));
    await guest.updateNetworkPolicy(engineSessionPolicy());
    await guest.writeFiles([{ path: "/tmp/session-probe.py", content: PROBE, mode: 0o755 }]);
    const command = await guest.runCommand({ cmd: "/usr/bin/python3", args: ["/tmp/session-probe.py"], env: guestEnvOf({}), detached: true });
    let out = "";
    for await (const log of command.logs()) if (log.stream === "stdout") out += typeof log.data === "string" ? log.data : Buffer.from(log.data as Uint8Array).toString("utf8");
    expect((await command.wait()).exitCode).toBe(0);
    const answered = JSON.parse(out.trim().split("\n").pop() as string) as Record<string, { status: string; body: string }>;
    expect(answered["git"]!.status).toBe("exit 0");
    expect(answered["git"]!.body).toMatch(/^[0-9a-f]{40}\s+HEAD$/);
    expect(answered["zen"]!.status).toBe("ok");
    expect(answered["cloud"]!.status).toBe("refused");
    expect(answered["cloud"]!.body).toContain("403");
    expect(answered["uploads"]!.status).toBe("refused");
    expect(answered["uploads"]!.body).toContain("403");
  }, 600_000);
});
