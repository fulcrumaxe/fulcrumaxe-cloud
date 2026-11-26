import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statfsSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createChannelClient } from "../../src/engineHost/channelClient.js";
import { engineSessionPolicy } from "../../src/engineSession/sessionPolicy.js";
import { createBootFactsSource } from "../../src/vm/bootFacts.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { TEMPLATES } from "../../src/vm/lock.js";
import { GuestBindings } from "../../src/vm/sandboxd/guestBindings.js";
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
 * D#845 ON-13b1, the real half: the image's own `fx-engine-supervisor` bundle (node, as the unprivileged user, under /vercel/sandbox: the root disk is read-only) with a STAND-IN for the model CLI, in a real microVM on the
 * `engine_session` network. FX_SUPERVISOR_DRY=1 is the whole of it: no sign-in is read and no model is called, so it runs with FX_FORBID_MODEL_CALLS=1. It is skipped unless the five FX_VM_* variables name a helper socket
 * and a kernel and root disk built from THIS tree (`fx-runner vm build-image` through scripts/vm-main.mjs bundles the supervisor into the disk). It is in no workflow.
 *
 * Command (on this host, from packages/fx-runner, with the five FX_VM_* variables the engineSession.real run uses):
 *   FX_SUPERVISOR_DRY=1 FX_FORBID_MODEL_CALLS=1 pnpm exec vitest run test/vm/engineSupervisor.real.test.ts
 *
 * What it proves in the guest, with a stand-in that answers each message with a `result` and, after the first one, starts a background process (a marker written 4 seconds later) in the host's own process group:
 *  - the bundle runs as uid 1000 and listens on its unix socket (0600); the bridge is started by init, runs as root and listens on vsock 5255 (the process list shows both);
 *  - the closed messages answer as written: no_session_config, command_unverified, bad_request; token_put then tick starts the host with the token in ITS environment only; usage_tick has the stand-in's exact counts;
 *  - the host and its background process outlive the turn that started them (the marker is written after the `result`, stdin still open): the keep-one-host-open design, proved without a model;
 *  - stop wipes the token (reply says so, no state file holds it), ends the host with no survivor, and the supervisor program EXITS (Ruling 115: Node cannot zero the copies a launch makes, so the exit, the bridge's kill of the group and the guest's `init_on_free=1` are what keep the token out of a snapshot);
 *  - a RAM snapshot taken after the channel stop (the sandbox is persistent, `vmPort.stop` keeps one) holds neither the token nor its first 16 bytes, searched over every file of the snapshot directory; a search of the same files for a string that IS in the guest (the bridge's file name) is the control that the files are searchable.
 * The second case (ON-13b2) is the runner's own dial: `vmPort.channel` over vsock port 5255 to the bridge and the supervisor init started (which would run the image's own CLI, so it is never given a config or a tick that could start it): the closed refusals, `token_put`, a `halted` stop that wipes and ends with no survivor, a fresh supervisor after it, and a RAM snapshot with no token in it.
 */
const E = process.env;
const dry = E["FX_SUPERVISOR_DRY"] === "1";
const vmReady = E["FX_VM_HELPER_SOCKET"] !== undefined && E["FX_VM_TEMPLATE"] === TEMPLATES[0] && E["FX_VM_KERNEL"] !== undefined && E["FX_VM_ROOTFS"] !== undefined && E["FX_VM_AGENT"] !== undefined && process.geteuid?.() !== 0 && freemem() > 2.5 * 2 ** 30;
if (!(vmReady && dry)) console.warn("engineSupervisor.real: FX_SUPERVISOR_DRY=1 with the five FX_VM_* variables is not set; the real-VM supervisor run is skipped");

const HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");
const WORK = "/vercel/sandbox/fx-dry";
const CANARY = `fake-synthetic-dry-${randomBytes(12).toString("hex")}`;
const CHUNK = 8 * 2 ** 20;

/** True when the file holds `needle`: read in chunks that overlap by the needle's length less one, so a file of any size (a VM snapshot) is searched whole. A file that cannot be read throws. */
function fileHolds(file: string, needle: Buffer): boolean {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK + needle.length);
    let tail = 0;
    for (let pos = 0; pos < size; ) {
      const n = readSync(fd, buf, tail, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const total = tail + n;
      if (buf.subarray(0, total).includes(needle)) return true;
      tail = Math.min(needle.length - 1, total);
      buf.copy(buf, 0, total - tail, total);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}
/** Every regular file under `dir` (links are not followed). */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return lstatSync(f).isSymbolicLink() ? [] : e.isDirectory() ? filesUnder(f) : e.isFile() ? [f] : [];
  });
}
const STANDIN = `#!/opt/fx/bin/node
const fs = require("fs"), cp = require("child_process");
const rec = ${JSON.stringify(`${WORK}/record.jsonl`)}, log = (o) => fs.appendFileSync(rec, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
log({ event: "start", pid: process.pid, tokenSeen: token === ${JSON.stringify(CANARY)} });
out({ type: "system", subtype: "init", session_id: "e6a767e1-7e3f-44a4-bfb1-3c331803d4ee", apiKeySource: "none" });
let first = true, buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  while (buf.indexOf("\\n") >= 0) {
    buf = buf.slice(buf.indexOf("\\n") + 1);
    out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 }, modelUsage: { "claude-haiku-4-5": {} } });
    if (first) { first = false; cp.spawn("sh", ["-c", "sleep 4; touch ${WORK}/marker"], { stdio: "ignore" }).unref(); }
  }
});
process.stdin.on("end", () => { log({ event: "stdin_end" }); process.exit(0); });
`;

describe.skipIf(!(vmReady && dry))("the engine session's supervisor in a real microVM, with no model", () => {
  const uid = process.geteuid?.() ?? -1;
  let signed: SignedRelease | undefined;
  let daemon: ReturnType<typeof createProductionSandboxd>;
  let snapDir = "";
  let port: ReturnType<typeof createMicrovmSandbox>;
  let vmPort: ReturnType<typeof createMicrovmVmPort>;
  const made: string[] = [];
  beforeAll(async () => {
    snapDir = tempDir("fx-sup-snaps-");
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: E["FX_VM_KERNEL"] as string }, { kind: "rootfs", arch, file: E["FX_VM_ROOTFS"] as string }, { kind: "agent", arch, file: E["FX_VM_AGENT"] as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: TEMPLATES[0], nodeArch: process.arch, readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    const free = (dir: string): number | undefined => {
      const stats = statfsSync(dir);
      return stats.bavail * stats.bsize;
    };
    daemon = createProductionSandboxd({ helperSocket: E["FX_VM_HELPER_SOCKET"] as string, host: { euid: uid, platform: process.platform }, boot, snapshots: { dir: snapDir, quotaBytes: 4 * 1024 ** 3, freeBytes: free, stateDir: path.join(tempDir("fx-sup-state-"), "sandboxd") } });
    const helper = createHelperClient(connectUnix(E["FX_VM_HELPER_SOCKET"] as string));
    const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
    const sdk = createDaemonSdk({ daemon, policy, template: TEMPLATES[0], memMb: 2048 });
    port = createMicrovmSandbox({ sdk, makeRuntime: () => { throw new Error("the supervisor run starts no agent runtime"); } });
    vmPort = createMicrovmVmPort({ sandbox: port, daemon, bindings: new GuestBindings(), policy, idOf: sandboxIdOf, timeoutMs: 30 * 60_000, persistent: true });
  }, 120_000);
  afterEach(async () => {
    for (const name of made.splice(0)) await vmPort.delete(name).catch(() => undefined); // fx-swallow-ok: a sandbox the daemon no longer holds is the wanted state
  });
  afterAll(async () => {
    await signed?.close();
  });

  async function collect(cmd: { logs(): AsyncIterable<{ stream: string; data: unknown }> }): Promise<string> {
    let out = "";
    for await (const log of cmd.logs()) out += typeof log.data === "string" ? log.data : Buffer.from(log.data as Uint8Array).toString("utf8");
    return out;
  }

  it("dry run: the bundle, its bridge, the closed messages, usage_tick, a host that outlives its turn, and the wipe", { timeout: 6 * 60_000 }, async () => {
    const name = `fx-sup-${randomBytes(4).toString("hex")}`;
    made.push(name);
    await vmPort.create(name, "agent");
    const guest = await port.guestOf({ runId: "", sandboxName: name, sessionId: "" });
    await guest.updateNetworkPolicy(engineSessionPolicy());
    const run = async (cmd: string, args: string[]): Promise<{ exit: number; out: string }> => {
      const c = await guest.runCommand({ cmd, args, detached: true });
      const out = await collect(c);
      return { exit: (await c.wait()).exitCode, out };
    };
    const made1 = await run("mkdir", ["-p", WORK]);
    expect(made1.exit, made1.out).toBe(0);
    await guest.writeFiles([
      { path: `${WORK}/host-standin`, content: STANDIN, mode: 0o755 },
      { path: `${WORK}/canary`, content: CANARY, mode: 0o600 },
      { path: `${WORK}/engineSupervisorDry.py`, content: readFileSync(path.join(HELPERS, "engineSupervisorDry.py"), "utf8") },
    ]);
    // what init started: the bridge (root) and, through it, the supervisor as uid 1000 listening on its socket
    const procs = await run("/bin/sh", ["-c", "ps -eo user:20,args | grep -E 'engine-bridge|fx-engine-supervisor' | grep -v grep"]);
    const files = await run("/bin/sh", ["-c", "ls -l /usr/lib/fx/fx-engine-supervisor.mjs /usr/lib/fx/engine-bridge.py /run/fx-engine/channel.sock"]);
    const driven = await run("/usr/bin/python3", ["-I", `${WORK}/engineSupervisorDry.py`, WORK, `${WORK}/canary`]);
    const report = JSON.parse(/DRY_REPORT (.*)/.exec(driven.out)?.[1] ?? "{}") as Record<string, unknown>;
    console.error(`ENGINE SUPERVISOR DRY ${JSON.stringify({ report, bridge: procs.out.split("\n").filter(Boolean).map((l) => l.replace(/\s+/g, " ").slice(0, 80)), files: files.exit })}`);
    expect(procs.out, "init started the bridge as root").toMatch(/^root\s+\S*python3.*engine-bridge\.py/m);
    expect(procs.out, "the supervisor runs as the unprivileged user").toMatch(/^(ubuntu|1000)\s+\S*node.*fx-engine-supervisor\.mjs/m);
    expect(files.exit, files.out).toBe(0);
    expect(driven.out).not.toContain(CANARY);
    expect(report).toMatchObject({ ready: true, supervisor_exited: true, mode_0600: true, no_config: true, unverified: true, bad_request: true, token_put: true, tick: true, usage_tick: true, usage_exact: true, token_in_host_env: true, marker_after_turn: true, stdin_open_until_marker: true, stop: true, host_gone: true, tick_after_stop: true, token_in_state_files: false });
    // the marker was written well after the turn's result: the host and its process group were still alive
    expect(report["marker_after_result_s"] as number).toBeGreaterThanOrEqual(2);
    // RAM after the channel stop: the persistent sandbox's stop keeps a snapshot of the whole guest memory; the supervisor has exited, the bridge has killed the group, init_on_free has zeroed the pages
    await vmPort.stop(name);
    const snaps = filesUnder(snapDir);
    expect(snaps.length, "a snapshot was kept").toBeGreaterThan(0);
    const token = Buffer.from(CANARY);
    expect(snaps.filter((f) => fileHolds(f, Buffer.from("engine-bridge.py"))).length, "control: the search finds a string that is in the guest's memory").toBeGreaterThan(0);
    expect(snaps.filter((f) => fileHolds(f, token) || fileHolds(f, token.subarray(0, 16))), "no snapshot file holds the token or its first 16 bytes").toEqual([]);
  });

  it("dry run, the runner's own dial: vsock port 5255 reaches the bridge and a supervisor that has no config, takes the credential, and is wiped and ended by a halted channel stop before the snapshot", { timeout: 6 * 60_000 }, async () => {
    const name = `fx-chn-${randomBytes(4).toString("hex")}`;
    made.push(name);
    await vmPort.create(name, "agent");
    const guest = await port.guestOf({ runId: "", sandboxName: name, sessionId: "" });
    await guest.updateNetworkPolicy(engineSessionPolicy());
    const channel = createChannelClient(() => (vmPort.channel as NonNullable<typeof vmPort.channel>)(name), { timeoutMs: 20_000 });
    // init starts the bridge a moment after boot: the first answers may be `unreachable` until it listens
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await channel.eventsRead(0).then(() => true, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(up, "the host reached the supervisor through vsock 5255").toBe(true);
    // no config, so nothing can start (the image's own CLI is never run by this test), and an unverifiable command reaches nothing
    expect(await channel.ask({ op: "tick", kind: "loop" })).toEqual({ ok: false, code: "no_session_config" });
    expect(await channel.ask({ op: "command", command: { forged: true } })).toEqual({ ok: false, code: "command_unverified" });
    expect(await channel.ask({ op: "exec" })).toEqual({ ok: false, code: "bad_request" });
    await channel.tokenPut(Buffer.from(CANARY));
    expect(await channel.stop("halted")).toEqual({ survivors: 0, tokenWiped: true, pid: expect.any(Number) });
    // the supervisor ended, the bridge killed its group, and init starts a fresh one with no credential
    let fresh = false;
    for (let i = 0; i < 60 && !fresh; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      fresh = await channel.ask({ op: "tick", kind: "loop" }).then((r) => !r.ok && r.code === "no_session_config", () => false);
    }
    expect(fresh, "a fresh supervisor answers (it has no config, no host and no credential)").toBe(true);
    console.error(`ENGINE CHANNEL DRY ${JSON.stringify({ dial: up, fresh_supervisor: fresh })}`);
    await vmPort.stop(name);
    const snaps = filesUnder(snapDir);
    expect(snaps.length, "a snapshot was kept").toBeGreaterThan(0);
    const token = Buffer.from(CANARY);
    expect(snaps.filter((f) => fileHolds(f, Buffer.from("engine-bridge.py"))).length, "control: the search finds a string that is in the guest's memory").toBeGreaterThan(0);
    expect(snaps.filter((f) => fileHolds(f, token) || fileHolds(f, token.subarray(0, 16))), "no snapshot file holds the token or its first 16 bytes").toEqual([]);
  });
});
