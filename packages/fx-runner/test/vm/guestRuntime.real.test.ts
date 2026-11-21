import { freemem } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentHandle, LocalOnlyEvent, StartOptions } from "@fulcrumaxe/runner-protocol";
import { REQUIRED_FLAGS } from "../../src/engines/claude/argv.js";
import { outcomeOf } from "../../src/engines/claude/engine.js";
import { SUBSCRIPTION_TOKEN_VAR } from "../../src/job/cleanEnv.js";
import { createGuestAgent, viaFirecrackerVsock, type GuestAgent } from "../../src/vm/sandboxd/guestAgent.js";
import { createGuestRuntime, type GuestRuntimeConfig } from "../../src/vm/sandboxd/guestRuntime.js";
import type { StreamSpec } from "../../src/vm/sandboxd/sandboxd.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { RUN_ID, fixtureText } from "../engines/claude/harness.js";
import { GOLDEN_FILE, canonical } from "../engines/claude/streamScenarios.js";
import { bootVm, type Vm } from "./helpers/bootVm.js";

/**
 * D#587 B-5a-RT-3 against a REAL Firecracker booting the REAL root disk, with a SCRIPTED CLI: a small python program written into the guest, speaking
 * stream-json (init line with `apiKeySource: "none"`, assistant and result lines) and answering `--version` and `--help`. The real `claude` and a model
 * are A1 criterion 26 (3c), not here. The token is delivered with the production client's `putToken` and the CLI is started with `token: true` as the ordinary
 * user. Needs FX_VM_FIRECRACKER, FX_VM_KERNEL and FX_VM_ROOTFS (as vmToken.real.test.ts), runs as the ordinary user, and skips with a message without them.
 * One VM at a time: run it behind the heavy-check lock; it also skips when less than 1.5 GiB of memory is available.
 */
const env = { firecracker: process.env["FX_VM_FIRECRACKER"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"] };
const enoughMemory = freemem() > 1.5 * 2 ** 30;
const ready = env.firecracker !== undefined && env.kernel !== undefined && env.rootfs !== undefined && enoughMemory;
if (!ready) console.warn("guestRuntime.real: FX_VM_FIRECRACKER, FX_VM_KERNEL and FX_VM_ROOTFS are not all set (or memory is low); the real guest-runtime checks are skipped");

const WORKDIR = "/vercel/sandbox/work";
const CLI = "/tmp/fx-scripted-claude";
const SENTINEL = ["sk-ant", "oat01-REALVMSENTINEL0123456789abcdef"].join("-");
const tool = fixtureText("stream.tooluse.synthetic.jsonl");
const toolLines = tool.split("\n").filter((l) => l !== "");

const SCRIPT = `#!/usr/bin/python3
import json, os, signal, subprocess, sys, time
REQ = ${JSON.stringify(REQUIRED_FLAGS)}
if "--version" in sys.argv:
    print("2.1.295 (Claude Code)"); sys.exit(0)
if "--help" in sys.argv:
    print("\\n".join("  " + f for f in REQ)); sys.exit(0)
spec = json.loads(sys.stdin.read())
mode = spec["mode"]
def emit(o):
    sys.stdout.write((o if isinstance(o, str) else json.dumps(o, separators=(",", ":"))) + "\\n"); sys.stdout.flush()
def assistant(i, text):
    return {"type": "assistant", "session_id": "sess-0001", "message": {"id": "m%d" % i, "model": "claude-sonnet-5-5", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 1, "output_tokens": 1}}}
def result(text):
    r = json.loads(spec["result"]); r["result"] = text; return r
if mode == "play":
    sys.stdout.write(spec["text"]); sys.stdout.flush(); sys.exit(0)
emit(spec["init"])
if mode == "env":
    var = spec["var"]
    cli = "present" if var in os.environ else "absent"
    child_env = {k: v for k, v in os.environ.items() if k != var}
    child = subprocess.run(["sh", "-c", "printenv " + var + " >/dev/null && echo present || echo absent"], env=child_env, capture_output=True, text=True).stdout.strip()
    emit(result("cli=" + cli + " child=" + child)); sys.exit(0)
if mode == "int":
    def on_int(sig, frame):
        emit(result("interrupted")); sys.exit(0)
    signal.signal(signal.SIGINT, on_int)
    emit(assistant(1, "working"))
    while True: time.sleep(0.05)
if mode == "gc":
    subprocess.Popen(["setsid", "sh", "-c", "echo $$ > /tmp/fx-gc.pid; exec sleep 600"])
    emit(assistant(1, "working"))
    while True: time.sleep(0.05)
if mode == "exit":
    sys.exit(spec["code"])
if mode == "selfkill":
    os.kill(os.getpid(), signal.SIGKILL)
if mode == "hang":
    emit(assistant(1, "working"))
    while True: time.sleep(0.05)
if mode == "big":
    pad = "x" * spec["size"]
    for i in range(spec["count"]):
        emit(assistant(i, "t%d:" % i + pad))
    emit(result("done")); sys.exit(0)
`;

describe.skipIf(!ready)("the guest runtime, under a real Firecracker with a scripted CLI", () => {
  let work: string;
  let vm: Vm;
  let guest: GuestAgent;
  const specs: StreamSpec[] = [];
  beforeAll(async () => {
    work = mkdtempSync(path.join(socketTmpRoot(), "fx-vm-grt-"));
    vm = await bootVm({ firecracker: env.firecracker!, kernel: env.kernel!, rootfs: env.rootfs! }, path.join(work, "vm"), { memMib: 768, vcpus: 2 });
    guest = createGuestAgent(viaFirecrackerVsock(path.join(work, "vm", "v.sock")), 20_000);
    await guest.put({ path: CLI, mode: 0o755, size: Buffer.byteLength(SCRIPT), content: Buffer.from(SCRIPT) });
    await guest.put({ path: `${WORKDIR}/.keep`, size: 0, content: Buffer.alloc(0) });
  }, 180_000);
  afterAll(async () => {
    await vm?.stop().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  const logs = (): string => mkdtempSync(path.join(work, "log-"));
  function runtime(over: Partial<GuestRuntimeConfig> = {}): ReturnType<typeof createGuestRuntime> & { config: GuestRuntimeConfig } {
    const config: GuestRuntimeConfig = {
      launch: async (spec) => {
        specs.push(spec);
        return guest.streamInGuest({ id: spec.id, argv: [spec.cmd, ...(spec.args ?? [])], ...(spec.env === undefined ? {} : { env: spec.env }), ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }), ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }), ...(spec.timeoutS === undefined ? {} : { timeoutS: spec.timeoutS }), ...(spec.withToken === true ? { token: true } : {}), ...(spec.user === undefined ? {} : { user: spec.user }) });
      },
      writeFiles: async (files) => {
        for (const f of files) await guest.put({ path: f.path, ...(f.mode === undefined ? {} : { mode: f.mode }), size: Buffer.byteLength(f.content), content: Buffer.from(f.content) });
      },
      credentials: { mode: "subscription" },
      agentPath: CLI,
      logDir: logs(),
      killGraceMs: 1500,
      ...over,
    };
    return Object.assign(createGuestRuntime(config), { config });
  }
  const script = (extra: Record<string, unknown>): string => JSON.stringify({ init: toolLines[0], result: toolLines.find((l) => l.includes('"type":"result"')), ...extra });
  async function begin(rt: ReturnType<typeof runtime>, extra: Record<string, unknown>, over: Partial<StartOptions> = {}): Promise<{ handle: AgentHandle; events: Array<Record<string, unknown>> }> {
    await guest.putToken(Buffer.from(SENTINEL)); // one launch per delivery
    const events: Array<Record<string, unknown>> = [];
    const { handle } = await rt.start({ runId: RUN_ID, role: "executor", roleCard: "c", prompt: script(extra), model: "sonnet", workdir: WORKDIR, capUsd: 1, onEvent: (e) => void events.push(e as unknown as Record<string, unknown>), ...over } as StartOptions);
    return { handle, events };
  }
  const cliId = (): string => specs.filter((s) => s.withToken === true).at(-1)!.id;

  it("A: the scripted run's events, local events and outcome are the host engine's recorded ones for the same transcript", async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, string>;
    const locals: LocalOnlyEvent[] = [];
    const rt = runtime({ onLocalEvent: (e) => void locals.push(e) });
    const { handle, events } = await begin(rt, { mode: "play", text: tool });
    const done = await outcomeOf(handle);
    expect(canonical({ events, locals, outcome: done }, "<none>")).toBe(golden["tool use with structured output"]);
  }, 120_000);

  it("B: the token reaches the CLI (present) and the scrubbed child does not have it; no request, event or log line holds the sentinel or the variable's name", async () => {
    const rt = runtime();
    const { handle, events } = await begin(rt, { mode: "env", var: SUBSCRIPTION_TOKEN_VAR });
    const done = await outcomeOf(handle);
    expect(done.status).toBe("ok");
    expect(JSON.stringify(events)).toContain("cli=present child=absent");
    const logText = readFileSync(path.join(rt.config.logDir, `${RUN_ID}.jsonl`), "utf8");
    for (const text of [logText, JSON.stringify(events), JSON.stringify(specs)]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(SUBSCRIPTION_TOKEN_VAR);
    }
  }, 120_000);

  it("C: SIGINT ends a turn that traps it, with a result line (an ok run, not agent_exit), and the group was not signalled", async () => {
    const rt = runtime();
    const { handle, events } = await begin(rt, { mode: "int" });
    for (let i = 0; i < 400 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    expect(events.length).toBeGreaterThan(1); // the init event and the assistant line (sent after the CLI armed its handler)
    await rt.interrupt(handle);
    const done = await outcomeOf(handle);
    expect(done.status).toBe("ok");
    expect(JSON.stringify(events)).toContain("interrupted");
  }, 120_000);

  it("D: stop ends a CLI that spawned a setsid grandchild, and no process carrying the run's marker is left", async () => {
    const rt = runtime();
    const { handle, events } = await begin(rt, { mode: "gc" });
    for (let i = 0; i < 400 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    const id = cliId();
    await new Promise((r) => setTimeout(r, 500)); // the grandchild writes its pid a moment after the CLI's first line
    const before = await guest.runInGuest({ argv: ["sh", "-c", "cat /tmp/fx-gc.pid"], timeoutS: 20 });
    expect(Number(before.stdout.toString().trim())).toBeGreaterThan(1);
    await rt.stop(handle);
    await outcomeOf(handle);
    const scan = `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -q "^FX_CMD_ID=.*[.]${id}$" && echo "$p"; done; kill -0 "$(cat /tmp/fx-gc.pid)" 2>/dev/null && echo grandchild-alive; true`;
    const left = await guest.runInGuest({ argv: ["sh", "-c", scan], user: "root", timeoutS: 20 });
    expect(left.stdout.toString().trim()).toBe("");
  }, 120_000);

  it("E: an exit code and a signal each end agent_exit (with no result line)", async () => {
    for (const extra of [{ mode: "exit", code: 3 }, { mode: "selfkill" }]) {
      const { handle } = await begin(runtime(), extra);
      expect(await outcomeOf(handle), JSON.stringify(extra)).toMatchObject({ status: "failed", failureReason: "agent_exit" });
    }
  }, 120_000);

  it("E: the guest's own timeout ends agent_exit", async () => {
    const rt = runtime({ timeoutMs: () => 1 }); // the guest's limit is this plus the VM backstop (30 s)
    const { handle } = await begin(rt, { mode: "hang" });
    expect(await outcomeOf(handle)).toMatchObject({ status: "failed", failureReason: "agent_exit" });
  }, 120_000);

  it("G: a 20 MiB transcript is read in full and in order", async () => {
    const count = 100;
    const rt = runtime();
    const { handle, events } = await begin(rt, { mode: "big", size: 200 * 1024, count });
    expect((await outcomeOf(handle)).status).toBe("ok");
    const texts = events.filter((e) => e["type"] === "assistant").map((e) => String(e["text"]));
    expect(texts.length).toBe(count);
    texts.forEach((t, i) => expect(t.startsWith(`t${i}:`), `event ${i}`).toBe(true));
    expect(texts.reduce((n, t) => n + t.length, 0)).toBeGreaterThanOrEqual(count * 200 * 1024);
  }, 180_000);

  it("F: killing the VM mid-stream ends agent_exit and leaves nothing behind", async () => {
    const rt = runtime();
    const { handle, events } = await begin(rt, { mode: "hang" });
    for (let i = 0; i < 400 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    await vm.stop();
    expect(await outcomeOf(handle)).toMatchObject({ status: "failed", failureReason: "agent_exit" });
    await rt.stop(handle); // the guest is gone: the stop still resolves
    expect(await vm.exitedWithin(5000)).toBe(true);
  }, 120_000);
});
