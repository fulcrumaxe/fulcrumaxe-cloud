import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { freemem } from "node:os";
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
import { JobToken } from "../../src/vm/sandboxd/jobToken.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { createEgressPolicyPort } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk, sandboxIdOf } from "../../src/vm/sandboxd/sdkAdapter.js";
import { createMicrovmVmPort } from "../../src/vm/sandboxd/vmPort.js";
import { tempDir } from "../helpers/tempTree.js";
import { SPIKE_DIR, SPIKE_HOLD_S, SPIKE_MARKER, SPIKE_SCRIPT, SPIKE_SETTINGS, SPIKE_TOUCH, judgeSpike, spikePrompt } from "./helpers/engineSpike.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#845 ON-13b1 SPIKE GATE, the real half: the image's own agent CLI (/opt/fx/bin/claude) runs the engine host's argument vector inside a real microVM on the `engine_session` network, the model reached
 * through the host's reverse relay, on Haiku. It spends a subscription (one short turn and one small Agent), so it runs only on purpose and the Team Lead runs it by hand. It is skipped unless
 * FX_SPIKE_REAL=1, the five FX_VM_* variables (as in engineSession.real.test.ts) are set, FX_C26_CONFIG_DIR names a directory holding a throwaway sign-in's .credentials.json, and FX_FORBID_MODEL_CALLS is not "1".
 * FX_SPIKE_DRY=1 is the no-model rehearsal: the same VM, files and settings, then the guest CLI's `--version` only. It reads no sign-in, calls no model and may run with FX_FORBID_MODEL_CALLS=1; it must pass on the host before the real run.
 * It is in no workflow and must never be listed in one. The access token is read into a Buffer, handed to the runner's own delivery (B-6.4) and wiped; it is never logged, written or put in an argument or environment.
 *
 * What it answers: with the host's stdin held open, does a background Agent started in a turn keep running after that turn ends (its marker file is written later than the first `result` line)? The report it
 * prints is the judge's closed output only: the verdict, one reason, the seconds, the turn count, the model names and four token totals. Nothing the model said is printed.
 */
const E = process.env;
const configDir = E["FX_C26_CONFIG_DIR"];
const dry = E["FX_SPIKE_DRY"] === "1";
const vmReady = E["FX_VM_HELPER_SOCKET"] !== undefined && E["FX_VM_TEMPLATE"] === TEMPLATES[0] && E["FX_VM_KERNEL"] !== undefined && E["FX_VM_ROOTFS"] !== undefined && E["FX_VM_AGENT"] !== undefined && process.geteuid?.() !== 0 && freemem() > 2.5 * 2 ** 30;
const realReady = vmReady && !dry && E["FX_SPIKE_REAL"] === "1" && E["FX_FORBID_MODEL_CALLS"] !== "1" && configDir !== undefined && existsSync(configDir);
/** FX_SPIKE_DRY=1: the same VM, files and settings, and the guest CLI's `--version` only. No sign-in is read and no model is called, so it may run with FX_FORBID_MODEL_CALLS=1. */
const dryReady = vmReady && dry;
if (!realReady && !dryReady) console.warn("engineSpike.real: neither FX_SPIKE_DRY=1 nor FX_SPIKE_REAL=1 (with FX_C26_CONFIG_DIR an existing directory and FX_FORBID_MODEL_CALLS not 1) is set with the five FX_VM_* variables; the real-VM spike is skipped");

const MODEL = "claude-haiku-4-5";

describe.skipIf(!realReady && !dryReady)("the spike gate with the image's own agent CLI in a real microVM", () => {
  const uid = process.geteuid?.() ?? -1;
  let signed: SignedRelease | undefined;
  let daemon: ReturnType<typeof createProductionSandboxd>;
  let port: ReturnType<typeof createMicrovmSandbox>;
  let vmPort: ReturnType<typeof createMicrovmVmPort>;
  const made: string[] = [];
  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: E["FX_VM_KERNEL"] as string }, { kind: "rootfs", arch, file: E["FX_VM_ROOTFS"] as string }, { kind: "agent", arch, file: E["FX_VM_AGENT"] as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: TEMPLATES[0], nodeArch: process.arch, readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    const free = (dir: string): number | undefined => {
      const stats = statfsSync(dir);
      return stats.bavail * stats.bsize;
    };
    daemon = createProductionSandboxd({ helperSocket: E["FX_VM_HELPER_SOCKET"] as string, host: { euid: uid, platform: process.platform }, boot, snapshots: { dir: tempDir("fx-spike-snaps-"), quotaBytes: 4 * 1024 ** 3, freeBytes: free, stateDir: path.join(tempDir("fx-spike-state-"), "sandboxd") } });
    const helper = createHelperClient(connectUnix(E["FX_VM_HELPER_SOCKET"] as string));
    const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
    const sdk = createDaemonSdk({ daemon, policy, template: TEMPLATES[0], memMb: 2048 });
    port = createMicrovmSandbox({ sdk, makeRuntime: () => { throw new Error("the spike starts no agent runtime"); } });
    vmPort = createMicrovmVmPort({ sandbox: port, daemon, bindings: new GuestBindings(), policy, idOf: sandboxIdOf, timeoutMs: 30 * 60_000, persistent: false });
  }, 120_000);
  afterEach(async () => {
    for (const name of made.splice(0)) await vmPort.delete(name).catch(() => undefined); // fx-swallow-ok: a sandbox the daemon no longer holds is the wanted state
  });
  afterAll(async () => {
    await signed?.close();
  });

  /** The VM, its egress policy and the spike's files, as the real run needs them. A failing step names itself and carries the adapter's closed code, never a bare "internal". */
  async function prepare(): Promise<{ name: string; guest: Awaited<ReturnType<typeof port.guestOf>> }> {
    const name = `fx-spike-${randomBytes(4).toString("hex")}`;
    made.push(name);
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        const code = (err as { json?: { error?: { code?: string } } }).json?.error?.code;
        throw new Error(`spike setup step "${what}" failed${code === undefined ? "" : ` (${code})`}`, { cause: err });
      }
    };
    await step("create the VM", () => vmPort.create(name, "agent"));
    const guest = await step("reach the guest", () => port.guestOf({ runId: "", sandboxName: name, sessionId: "" }));
    await step("apply the engine_session policy", () => guest.updateNetworkPolicy(engineSessionPolicy()));
    // The agent makes a missing parent as its own user and the CLI runs as the unprivileged one: make the working directory first, as the guest's default user, so the background Agent can write its marker there.
    await step("make the working directory", async () => {
      const mk = await guest.runCommand({ cmd: "mkdir", args: ["-p", `${SPIKE_DIR}/.claude`], detached: true });
      const out = await collect(mk);
      const exit = (await mk.wait()).exitCode;
      if (exit !== 0) throw new Error(`mkdir exited ${exit}: ${out.slice(0, 200)}`);
    });
    await step("write the spike files", () =>
      guest.writeFiles([
        { path: "/tmp/engineSpike.py", content: SPIKE_SCRIPT, mode: 0o755 },
        { path: "/tmp/engineSpike-prompt.txt", content: spikePrompt() },
        { path: `${SPIKE_DIR}/.claude/settings.json`, content: SPIKE_SETTINGS },
      ]),
    );
    return { name, guest };
  }
  async function collect(cmd: { logs(): AsyncIterable<{ stream: string; data: unknown }> }): Promise<string> {
    let out = "";
    for await (const log of cmd.logs()) out += typeof log.data === "string" ? log.data : Buffer.from(log.data as Uint8Array).toString("utf8");
    return out;
  }

  it.skipIf(!dryReady)("dry run: the VM, files and settings are in place and the guest CLI starts with --version, with no sign-in and no model", { timeout: 5 * 60_000 }, async () => {
    const { guest } = await prepare();
    const run = async (cmd: string, args: string[]): Promise<{ exit: number; out: string }> => {
      const c = await guest.runCommand({ cmd, args, cwd: SPIKE_DIR, detached: true });
      const out = await collect(c);
      return { exit: (await c.wait()).exitCode, out };
    };
    const script = await run("/usr/bin/python3", ["-m", "py_compile", "/tmp/engineSpike.py"]);
    const settings = await run("/bin/cat", [`${SPIKE_DIR}/.claude/settings.json`]);
    const writable = await run("/bin/sh", ["-c", `touch ${SPIKE_DIR}/.probe && rm ${SPIKE_DIR}/.probe`]);
    const touched = await run("/bin/sh", ["-c", `rm -f ${SPIKE_MARKER}; ${SPIKE_TOUCH} && test -f ${SPIKE_MARKER} && rm ${SPIKE_MARKER}`]);
    const version = await run("/opt/fx/bin/claude", ["--version"]);
    console.error(`ENGINE SPIKE DRY ${JSON.stringify({ script: script.exit, settings: settings.exit, writable: writable.exit, touch: touched.exit, version: version.exit, versionLine: version.out.trim().slice(0, 60) })}`);
    expect(script.exit, "the spike script compiles in the guest").toBe(0);
    expect(settings.out, "the project settings read back as written").toBe(SPIKE_SETTINGS);
    expect(writable.exit, "the working directory is writable by the CLI's user").toBe(0);
    expect(touched.exit, "the exact allowed touch command creates the marker file as the CLI's user").toBe(0);
    expect(version.exit, "the guest CLI starts with --version").toBe(0);
    expect(version.out.trim(), "--version prints a version").toMatch(/\d+\.\d+/);
  });

  it.skipIf(!realReady)("prints the verdict: does a background Agent survive the end of a turn with stdin held open", { timeout: 20 * 60_000 }, async () => {
    const { name } = await prepare();
    const sandbox = await daemon.get(sandboxIdOf(name));
    const token = new JobToken(sandbox);
    const parsed = JSON.parse(readFileSync(path.join(configDir as string, ".credentials.json"), "utf8")) as { claudeAiOauth?: { accessToken?: unknown } };
    const secret = parsed.claudeAiOauth?.accessToken;
    if (typeof secret !== "string" || secret === "") throw new Error("the throwaway sign-in holds no access token");
    let out = "";
    try {
      await token.deliver(() => Buffer.from(secret));
      const stream = await token.launchStream({ id: "spike", cmd: "/usr/bin/python3", args: ["/tmp/engineSpike.py", "/opt/fx/bin/claude", "/tmp/engineSpike-prompt.txt", SPIKE_MARKER, String(SPIKE_HOLD_S), MODEL], cwd: SPIKE_DIR, env: guestEnvOf({}), timeoutS: SPIKE_HOLD_S + 120 });
      for await (const frame of stream.frames) if (frame.stream === "stdout") out += frame.data.toString("utf8");
      await stream.done;
    } finally {
      await token.wipe();
    }
    const report = judgeSpike(out.split(secret).join("[TOKEN]"));
    console.error(`ENGINE SPIKE REPORT ${JSON.stringify(report)}`);
    expect(report.verdict, `the spike report is ${JSON.stringify(report)}`).toBe("survived");
  });
});
