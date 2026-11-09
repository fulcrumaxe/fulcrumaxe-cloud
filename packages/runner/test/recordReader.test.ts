import { describe, expect, it, vi } from "vitest";
import { createUsageMeter } from "../src/meteringGuard.js";
import {
  CLAUDE_CLI_VERSION,
  PROMPT_WRAPPER,
  READ_FAILURE_LIMIT,
  RecordLedger,
  SandboxPortError,
  agentCommandArgs,
  agentRecorderFiles,
  createVercelSandboxPort,
  crossCheckEcho,
  logBytes,
  probeExit,
  readBytes,
  readRecords,
  recordPathFor,
  startAgentCommand,
  type SdkCommand,
  type SdkSandbox,
  type VercelSandboxSdk,
} from "../src/vercelSandboxPort.js";
import { FX_RECORDER_PATH, FX_RECORDER_SCRIPT } from "../src/agentConfig.js";
import { RECORD_READ_CAP, acceptRecords, type AcceptedRecord } from "../src/recordParser.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import type { NormalizedEvent } from "../src/types.js";
import type { EventMeta, ReaderFlag, SandboxHandle, StartDetachedOptions } from "../src/sandboxPort.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";
import { sdkSessionStubs } from "./helpers/sdkSession.js";
import { createRecordingVm, frameRecord, recordFile, recordingSdk, type RecordingVm, type RecordingVmOptions } from "./helpers/recorderSdk.js";
import { nodeCmd, recorderDir, runRecorder } from "./helpers/recorderHarness.js";

const NAME = "rn-8-reviewer-run-1";
const RUN = "run-1";
const REC = recordPathFor(RUN);

interface Script {
  /** The scripted agent's stdout, one chunk per entry (a line carries its own newline). */
  stdout: string[];
  /** Instead of `stdout`: the scripted agent's output as it is produced, so a test can act between two lines. */
  gen?: () => AsyncGenerator<{ stream: string; data: string }>;
  exit?: number;
  /** The scripted agent never ends: its stdout stays open and its `wait` never returns. */
  endless?: boolean;
}

/** A plain `SdkSandbox` whose agent command prints a script: what the recording VM wraps. The recorder is the VM's; this is the CLI it runs. */
function scriptedSandbox(script: Script): SdkSandbox {
  return {
    name: NAME,
    async runCommand(params) {
      if (params.args?.[2] === "fx-pin") return { async *logs() { yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION} (Claude Code)\n` }; }, wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
      return {
        cmdId: "child",
        async *logs() {
          if (script.gen) yield* script.gen();
          else for (const chunk of script.stdout) yield { stream: "stdout", data: chunk };
          if (script.endless) await new Promise<never>(() => undefined);
        },
        wait: async () => {
          if (script.endless) await new Promise<never>(() => undefined);
          return { exitCode: script.exit ?? 0 };
        },
        kill: async () => undefined,
      };
    },
    async writeFiles() {},
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    ...sdkSessionStubs(),
  };
}

const assistant = (id: string, tokens = 10): string => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text: `text ${id}` }], usage: { input_tokens: tokens, output_tokens: 1 } } }) + "\n";
const result = (): string => JSON.stringify({ type: "result", is_error: false, result: "done", session_id: "s1" }) + "\n";

/** The functions, one at a time, against a sandbox with the recorder started: no port around them. */
async function fnRig(script: Script, vmOpts: RecordingVmOptions = {}) {
  const vm = createRecordingVm(vmOpts);
  const sb = vm.wrap(scriptedSandbox(script));
  await sb.writeFiles([{ path: "/tmp/fx-prompt-1", content: "p", mode: 0o600 }, ...agentRecorderFiles()]);
  const cmd = await startAgentCommand(sb, { promptFile: "/tmp/fx-prompt-1", runId: RUN, agentArgv: ["claude", "-p"], env: {}, timeoutMs: 1000 });
  return { vm, sb, cmd };
}
const settled = async (cmd: SdkCommand): Promise<void> => {
  const p = await probeExit(cmd, 2000);
  expect(p.exited).toBe(true);
};

describe("RLR-3b startAgentCommand: the recorder argv, its files, and no subscriber (B1)", () => {
  it("builds the wrapper, the recorder and the CLI into one argv and writes the recorder 0444 with a directory for its file", async () => {
    expect(agentCommandArgs({ promptFile: "/tmp/fx-prompt-1", runId: RUN, agentArgv: ["claude", "-p"] })).toEqual([
      "-c", PROMPT_WRAPPER, "fx-agent", "/tmp/fx-prompt-1", "node", FX_RECORDER_PATH, REC, RUN, "--", "claude", "-p",
    ]);
    expect(REC).toBe("/fx/run/run-1.rec");
    const { vm } = await fnRig({ stdout: [assistant("m1")] });
    expect(vm.files.get(FX_RECORDER_PATH)).toMatchObject({ mode: 0o444 });
    expect(vm.files.get(FX_RECORDER_PATH)!.content.toString()).toBe(FX_RECORDER_SCRIPT);
    expect(vm.dirs.has("/fx/run")).toBe(true);
  });

  it("starts the command and never attaches a logs() subscriber to it, however the run ends", async () => {
    const { vm, cmd } = await fnRig({ stdout: [assistant("m1")] });
    await settled(cmd);
    expect(vm.log.filter((e) => e.kind === "agent_logs")).toEqual([]);
    expect(vm.logsBeforeExit()).toBe(0);
  });

  it("refuses a run id the record path cannot carry, before any command", () => {
    for (const bad of ["", "../x", "a/b", ".hidden", "x y", "a".repeat(200)]) expect(() => recordPathFor(bad), bad).toThrow(/runId/);
  });

  it("the VM refuses what the real VM refuses: no recorder script, a changed one, no directory, a file already at the path", async () => {
    const vm = createRecordingVm();
    const sb = vm.wrap(scriptedSandbox({ stdout: [] }));
    const start = () => startAgentCommand(sb, { promptFile: "/tmp/fx-prompt-1", runId: RUN, agentArgv: ["claude"], env: {}, timeoutMs: 1000 });
    const code = async (): Promise<number> => (await (await start()).wait()).exitCode;
    expect(await code()).toBe(97); // no prompt file
    await sb.writeFiles([{ path: "/tmp/fx-prompt-1", content: "p" }]);
    expect(await code()).toBe(1); // no recorder script
    await sb.writeFiles([{ path: "/tmp/fx-prompt-1", content: "p" }, { path: FX_RECORDER_PATH, content: "// not the recorder", mode: 0o444 }]);
    expect(await code()).toBe(1); // a changed one
    await sb.writeFiles([{ path: "/tmp/fx-prompt-1", content: "p" }, { path: FX_RECORDER_PATH, content: FX_RECORDER_SCRIPT, mode: 0o444 }]);
    expect(await code()).toBe(98); // no /fx/run
    await sb.writeFiles([{ path: "/tmp/fx-prompt-1", content: "p" }, ...agentRecorderFiles()]);
    vm.setFile(REC, Buffer.from("planted"));
    expect(await code()).toBe(98); // O_EXCL: the path is taken
    expect(vm.file(REC)!.toString()).toBe("planted");
  });
});

describe("RLR-3b readRecords (B2): one read, one subscriber, the one parser", () => {
  it("reads the records in order from an offset, holding one subscriber per read, and advances by the bytes accepted", async () => {
    const { vm, sb, cmd } = await fnRig({ stdout: [assistant("m1"), assistant("m2"), result()] });
    await settled(cmd);
    const first = await readRecords(sb, { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 1000 });
    expect(first.fault).toBeNull();
    expect(first.records.map((r) => r.kind)).toEqual(["h", "o", "o", "o", "x"]);
    expect(first.run).toBe(RUN);
    expect(first.trailer).toMatchObject({ code: 0, sig: null, lines: 3 });
    expect(first.bytes).toBe(vm.file(REC)!.length);
    const again = await readRecords(sb, { recordPath: REC, offset: first.bytes, nextSeq: 5, timeoutMs: 1000 });
    expect(again).toMatchObject({ records: [], fault: null, size: first.bytes });
    expect(vm.log.filter((e) => e.kind === "read_logs")).toHaveLength(2); // one subscriber per read
    expect(vm.log.filter((e) => e.kind === "read")).toEqual([
      expect.objectContaining({ offset: 0, path: REC, cap: 8 * 1024 * 1024 }),
      expect.objectContaining({ offset: first.bytes }),
    ]);
  });

  it("a read of a file the VM does not have is a failed read, never an idle agent", async () => {
    const { sb } = await fnRig({ stdout: [] });
    expect(await readRecords(sb, { recordPath: "/fx/run/none.rec", offset: 0, nextSeq: 0, timeoutMs: 1000 })).toMatchObject({ fault: "read_failed", size: null, records: [] });
  });

  it("a read command that exits non-zero, or never ends (killed at the bound), is a failed read", async () => {
    const bad = await fnRig({ stdout: [assistant("m1")] }, { readExit: 1 });
    await settled(bad.cmd);
    expect((await readRecords(bad.sb, { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 1000 })).fault).toBe("read_failed");
    const hung = await fnRig({ stdout: [assistant("m1")] }, { readHangs: true });
    await settled(hung.cmd);
    const abandon = vi.fn(async () => undefined);
    expect((await readRecords(hung.sb, { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 30, abandon })).fault).toBe("read_failed");
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("a lossy read (a chunk dropped from the middle) yields only the records before the damage, with the offset of exactly those", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => assistant(`m${i}`));
    const lossy = await fnRig({ stdout: lines }, { readFilter: (d) => Buffer.concat([d.subarray(0, 700), d.subarray(900)]) });
    await settled(lossy.cmd);
    const out = await readRecords(lossy.sb, { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 1000 });
    const whole = acceptRecords(lossy.vm.file(REC)!, 0);
    expect(out.fault).toBeNull();
    expect(out.records.length).toBeGreaterThan(0);
    expect(out.records.length).toBeLessThan(whole.records.length);
    // every record it did return is the true one at that seq, and the offset is the end of the last of them
    expect(out.records.map((r) => r.data.toString())).toEqual(whole.records.slice(0, out.records.length).map((r) => r.data.toString()));
    expect(out.bytes).toBe(whole.records.slice(0, out.records.length).reduce((n, r) => n + r.size, 0));
    expect(out.stop).not.toBeNull();
  });

  it("a hostile file with a raw 0xff or other non-UTF-8 bytes mid-data yields only the records before the damage, with the right offset", async () => {
    for (const bytes of [[0xff], [0xc3, 0x28], [0x80, 0x80], [0xef, 0xbf, 0xbd]]) {
      const { vm, sb, cmd } = await fnRig({ stdout: [assistant("m1"), assistant("m2"), assistant("m3"), result()] });
      await settled(cmd);
      const whole = vm.file(REC)!;
      const good = acceptRecords(whole, 0).records;
      const at = good[0]!.size + good[1]!.size + 10; // inside record 2 (seq 1 is the second record)
      vm.setFile(REC, Buffer.concat([whole.subarray(0, at), Buffer.from(bytes), whole.subarray(at)]));
      const out = await readRecords(sb, { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 1000 });
      expect(out.fault, String(bytes)).toBeNull();
      expect(out.records.map((r) => r.seq), String(bytes)).toEqual([0, 1]);
      expect(out.bytes).toBe(good[0]!.size + good[1]!.size);
      expect(out.stop).not.toBeNull();
    }
  });

  it("only the U+FFFD that starts the @size suffix is read as the 0xff byte; any other one is damage that stays non-ASCII", () => {
    const b = readBytes("abc�@123");
    expect([...b]).toEqual([0x61, 0x62, 0x63, 0xff, 0x40, 0x31, 0x32, 0x33]);
    expect([...readBytes("a�b�@7")]).toEqual([0x61, 0x80, 0x62, 0xff, 0x40, 0x37]);
    expect(readBytes("abc�@12x").includes(0xff)).toBe(false); // text after the digits: not the suffix
    expect(readBytes("�@").includes(0xff)).toBe(false); // no digits
    expect(readBytes("�@1234567890123456").includes(0xff)).toBe(false); // more digits than a size has
    expect(readBytes("xÿy@5").includes(0xff)).toBe(false); // a latin1 byte is not the vendor's replacement
    expect([...logBytes("é😀")]).toEqual([0x80, 0x80, 0x80]);
  });

  it("a suffix split across chunks parses as a whole; a cut or missing suffix is a failed read, like a cut read", async () => {
    const body = acceptRecords(recordFile(RUN, ["x"]), 0);
    const bytes = recordFile(RUN, ["x"]);
    expect(body.records).toHaveLength(3);
    const stub = (chunks: string[]): Pick<SdkSandbox, "runCommand"> => ({
      runCommand: async () => ({ async *logs() { for (const data of chunks) yield { stream: "stdout", data }; }, wait: async () => ({ exitCode: 0 }), kill: async () => undefined }),
    });
    const text = bytes.toString("latin1");
    const size = `@${bytes.length}`;
    const read = (chunks: string[]) => readRecords(stub(chunks), { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 1000 });
    expect((await read([text, "�", size])).records).toHaveLength(3);
    expect((await read([text, "�@", size.slice(1, 3), size.slice(3)])).records).toHaveLength(3);
    for (const cut of [[text], [text, "�"], [text, "�@"], [text, "�@12x"], [text, "@" + bytes.length]]) {
      const out = await read(cut);
      expect(out, JSON.stringify(cut.slice(1))).toMatchObject({ fault: "read_failed", records: [], size: null });
    }
    // a read cut in the middle of a record, with its suffix: a partial line, not a bad one
    const cutRecord = await read([text.slice(0, text.length - 20), "�@" + bytes.length]);
    expect(cutRecord.fault).toBeNull();
    expect(cutRecord.records).toHaveLength(2);
  });

  it("a missing trailer: the file of a recorder killed with SIGKILL has the records and no trailer", async () => {
    const { vm, sb, cmd } = await fnRig({ stdout: [assistant("m1")], endless: true });
    await vi.waitFor(() => expect(vm.file(REC)!.length).toBeGreaterThan(0));
    vm.killRecorder();
    const exit = await probeExit(cmd, 1000);
    expect(exit).toEqual({ exited: true, exitCode: 137 });
    const out = await readRecords(sb, { recordPath: REC, offset: 0, nextSeq: 0, timeoutMs: 1000 });
    expect(out.trailer).toBeNull();
    expect(out.records.map((r) => r.kind)).toEqual(["h", "o"]);
  });
});

describe("RLR-3b probeExit (B4 step 1)", () => {
  it("a running command: the wait is aborted by its own timeout and that means still running, not an error", async () => {
    const { vm, cmd } = await fnRig({ stdout: [], endless: true });
    expect(await probeExit(cmd, 20)).toEqual({ exited: false });
    expect(vm.log.filter((e) => e.kind === "agent_wait")).toEqual([expect.objectContaining({ signal: true, outcome: "aborted" })]);
    // the abort is a TimeoutError DOMException (what AbortSignal.timeout gives its reason); an AbortError counts too
    const aborting: SdkCommand = { logs: () => (async function* () {})(), kill: async () => undefined, wait: async () => { throw new DOMException("x", "AbortError"); } };
    expect(await probeExit(aborting, 20)).toEqual({ exited: false });
  });

  it("an exited command: the exit code from wait(); getCommand().exitCode is never read", async () => {
    const { vm, cmd } = await fnRig({ stdout: [assistant("m1")], exit: 7 });
    expect(await probeExit(cmd, 1000)).toEqual({ exited: true, exitCode: 7 });
    expect(vm.log.some((e) => e.kind === "exit_code_read")).toBe(false);
  });

  it("any other failure of wait() is an error, not 'still running'", async () => {
    const failing: SdkCommand = { logs: () => (async function* () {})(), kill: async () => undefined, wait: async () => { throw Object.assign(new Error("x"), { response: { status: 502 } }); } };
    await expect(probeExit(failing, 20)).rejects.toMatchObject({ name: "SandboxPortError", operation: "wait", status: 502 });
    const nonsense: SdkCommand = { logs: () => (async function* () {})(), kill: async () => undefined, wait: async () => ({ exitCode: 300 }) };
    await expect(probeExit(nonsense, 20)).rejects.toBeInstanceOf(SandboxPortError);
  });
});

describe("RLR-3b crossCheckEcho (B4 step 3): max(file, echo)", () => {
  const ledgerOf = (records: AcceptedRecord[]): RecordLedger => {
    const l = new RecordLedger();
    for (const r of records) l.add(r);
    return l;
  };

  it("an echo equal to the file is one replay, no mismatch, nothing echo-only", async () => {
    const { vm, sb, cmd } = await fnRig({ stdout: [assistant("m1"), assistant("m2"), result()] });
    await settled(cmd);
    const file = acceptRecords(vm.file(REC)!, 0);
    const only: AcceptedRecord[] = [];
    const check = await crossCheckEcho(cmd, { ledger: ledgerOf(file.records), trailer: file.trailer }, { onEchoOnly: async (r) => void only.push(r) });
    expect(check).toMatchObject({ unavailable: false, mismatch: false, hasHeader: true, count: 5 });
    expect(check.trailer).toMatchObject({ code: 0, lines: 3 });
    expect(only).toEqual([]);
    expect(vm.log.filter((e) => e.kind === "agent_logs")).toEqual([expect.objectContaining({ exited: true })]); // one replay, after exit
    void sb;
  });

  it("records the file lacks (hidden before they were read) come out of the echo, as do records the file has differently", async () => {
    const { vm, cmd } = await fnRig({ stdout: [assistant("m1"), assistant("m2"), assistant("m3"), result()] });
    await settled(cmd);
    const real = acceptRecords(vm.file(REC)!, 0);
    // the file as an agent with the recorder's uid would leave it: m2 gone, m3 rewritten, the rest renumbered and re-checksummed
    const forged = acceptRecords(recordFile(RUN, [assistant("m1").trim(), assistant("m3").replace("text m3", "text zz").trim(), result().trim()]), 0);
    const only: AcceptedRecord[] = [];
    const check = await crossCheckEcho(cmd, { ledger: ledgerOf(forged.records), trailer: forged.trailer }, { onEchoOnly: async (r) => void only.push(r) });
    expect(check.mismatch).toBe(true);
    // from the first differing seq on, every `o` record of the echo is handed over, in order
    expect(only.map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(only.map((r) => r.data.toString()).join("")).toContain("m3");
    expect(real.records).toHaveLength(6);
  });

  it("a file longer than the echo, or a different trailer, is a mismatch too", async () => {
    const { vm, cmd } = await fnRig({ stdout: [assistant("m1")] });
    await settled(cmd);
    const real = acceptRecords(vm.file(REC)!, 0);
    const longer = acceptRecords(recordFile(RUN, [assistant("m1").trim(), "extra"]), 0);
    expect((await crossCheckEcho(cmd, { ledger: ledgerOf(longer.records), trailer: longer.trailer }, { onEchoOnly: async () => undefined })).mismatch).toBe(true);
    const otherTrailer = acceptRecords(recordFile(RUN, [assistant("m1").trim()], { code: 5, sig: null }), 0);
    expect((await crossCheckEcho(cmd, { ledger: ledgerOf(otherTrailer.records), trailer: otherTrailer.trailer }, { onEchoOnly: async () => undefined })).mismatch).toBe(true);
    expect(real.trailer).toMatchObject({ code: 0 });
  });

  it("an echo that cannot be replayed is 'unavailable'; an error from the caller's own handler is not swallowed", async () => {
    const broken: SdkCommand = { logs: () => (async function* () { throw new Error("stream lost"); })(), wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
    expect(await crossCheckEcho(broken, { ledger: new RecordLedger(), trailer: null }, { onEchoOnly: async () => undefined })).toMatchObject({ unavailable: true });
    const { vm, cmd } = await fnRig({ stdout: [assistant("m1")] });
    await settled(cmd);
    const stop = new Error("spend kill");
    await expect(crossCheckEcho(cmd, { ledger: new RecordLedger(), trailer: null }, { onEchoOnly: async () => { throw stop; } })).rejects.toBe(stop);
    void vm;
  });
});

describe("RLR-3b the real recorder and the fake agree", () => {
  it("the fake's record file is byte for byte what FX_RECORDER_SCRIPT writes, for text, unicode, invalid UTF-8, a tail and an exit code", async () => {
    const d = recorderDir();
    try {
      const js = 'process.stdout.write("plain\\n"); process.stdout.write("caf\\u00e9 \\ud83d\\ude00\\n"); process.stdout.write(Buffer.from([0x66,0xff,0x6f,0x0a])); process.stdout.write("no newline"); process.exit(3)';
      const real = await runRecorder(d, nodeCmd(js));
      const lines: Array<string | Buffer | { tail: string }> = ["plain", "café 😀", Buffer.from([0x66, 0xff, 0x6f]), { tail: "no newline" }];
      const mine = recordFile("run-x", lines, { code: 3, sig: null });
      expect(real.file.toString("latin1")).toBe(mine.toString("latin1"));
      expect(real.echo.toString("latin1")).toBe(mine.toString("latin1"));
      expect(frameRecord({ s: 1, k: "o", n: 3, d: "abc" }).toString()).toContain('"t":1');
    } finally {
      d.done();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// The port, whole: the in-process path is rebuilt on those functions.

const RUN_LIMITS = { maxTurns: 17, maxModelCalls: 40, maxRunMs: 9 * 60_000, meteringSilenceMs: 11 * 60_000 };

type RigExtra = { limits?: Partial<typeof RUN_LIMITS>; callTimeoutMs?: number; getToken?: () => Promise<string>; wrapSdk?: (sdk: VercelSandboxSdk & { vm: RecordingVm }) => VercelSandboxSdk };

function portRig(script: Script, vmOpts: RecordingVmOptions = {}, readerTiming: { probeMs?: number; trailerWaitMs?: number; echoTimeoutMs?: number; exitWaitMs?: number } = {}, extra: RigExtra = {}) {
  const inner = scriptedSandbox(script);
  const raw: VercelSandboxSdk = { create: async () => inner, get: async () => inner };
  const sdk = recordingSdk(raw, createRecordingVm(vmOpts));
  const port = createVercelSandboxPort({
    teamId: "t",
    projectId: "p",
    getToken: extra.getToken ?? (async () => "tok"),
    sdk: extra.wrapSdk ? extra.wrapSdk(sdk) : sdk,
    ...(extra.callTimeoutMs !== undefined && { callTimeoutMs: extra.callTimeoutMs }),
    ...(extra.limits !== undefined && { limits: extra.limits }),
    reader: { probeMs: 20, trailerWaitMs: 60, ...readerTiming },
  });
  const events: NormalizedEvent[] = [];
  const flags: ReaderFlag[] = [];
  const opts = (over: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({
    runId: RUN,
    role: "code-reviewer",
    roleCard: "card",
    prompt: "go",
    model: "sonnet-5",
    capUsd: 5,
    networkPolicy: keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
    env: buildSandboxEnv("code-reviewer"),
    onEvent: async (e) => void events.push(e),
    onReaderFlag: (f) => void flags.push(f),
    limits: RUN_LIMITS,
    ...over,
  });
  const run = async (over: Partial<StartDetachedOptions> = {}) => {
    const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })) });
    return port.startDetached(handle, opts(over)).hookFired;
  };
  return { vm: sdk.vm, port, events, flags, run, opts };
}

const usageSum = (events: NormalizedEvent[]): number => {
  const meter = createUsageMeter();
  let sum = 0;
  for (const e of events) if (e.usage) sum += meter.observeRise(e)?.delta.inputTokens ?? 0;
  return sum;
};

describe("RLR-3b the in-process path on the reader", () => {
  it("a run is read through the record file: every line once, in order, no flag, and the agent command's logs() is first read after it exited, once", async () => {
    const r = portRig({ stdout: [assistant("m1", 10), assistant("m2", 20), result()] });
    const last = await r.run();
    expect(last?.type).toBe("result");
    expect(r.events.map((e) => e.type)).toEqual(["assistant", "assistant", "result"]);
    expect(r.flags).toEqual([]);
    expect(usageSum(r.events)).toBe(30);
    const agentLogs = r.vm.log.filter((e) => e.kind === "agent_logs");
    expect(agentLogs).toEqual([expect.objectContaining({ exited: true })]);
    expect(r.vm.logsBeforeExit()).toBe(0);
    expect(r.vm.log.some((e) => e.kind === "exit_code_read")).toBe(false);
  });

  it("the agent command never gets a logs() subscriber while it is running, however long the reader polls", async () => {
    const r = portRig({ stdout: [assistant("m1")], endless: true });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })) });
    const { hookFired } = r.port.startDetached(handle, r.opts());
    await vi.waitFor(() => expect(r.vm.log.filter((e) => e.kind === "read").length).toBeGreaterThan(4)); // several reads and probes with the agent still running
    expect(r.vm.log.filter((e) => e.kind === "agent_logs")).toEqual([]);
    expect(r.vm.log.filter((e) => e.kind === "agent_wait").every((e) => e.signal === true)).toBe(true);
    await r.port.stop(handle);
    await expect(hookFired).resolves.toBeUndefined();
    expect(r.vm.logsBeforeExit()).toBe(0); // not even when a stop ends it: the one replay a stop takes comes after the command has exited
    expect(r.vm.log.filter((e) => e.kind === "agent_logs")).toEqual([expect.objectContaining({ exited: true })]);
  });

  it("lossy reads change nothing: lines come out once, whole and in order", async () => {
    let n = 0;
    const lines = Array.from({ length: 12 }, (_, i) => assistant(`m${i}`, 1));
    const r = portRig({ stdout: [...lines, result()] }, { readFilter: (d) => (n++ === 0 ? Buffer.concat([d.subarray(0, 500), d.subarray(700)]) : d), chunkBytes: 64 });
    const last = await r.run();
    expect(last?.type).toBe("result");
    expect(r.events.filter((e) => e.type === "assistant")).toHaveLength(12);
    expect(usageSum(r.events)).toBe(12);
    expect(r.flags).toEqual([]);
    expect(n).toBeGreaterThan(1);
  });


  it("an echo that differs from the file raises the meter to max(file, echo) and flags record_mismatch", async () => {
    // The first complete read finds the file as an agent with the recorder's uid would leave it: the big usage lines gone, the rest renumbered and re-checksummed.
    const real = [assistant("m1", 10), assistant("m2", 1000), assistant("m3", 2000), result()];
    const hidden = recordFile(RUN, [real[0]!.trim(), real[3]!.trim()]);
    let swapped = false;
    const r = portRig({ stdout: real }, {
      onRead: (path, vm) => {
        if (swapped || !acceptRecords(vm.file(path) ?? Buffer.alloc(0), 0).trailer) return;
        swapped = true;
        vm.setFile(path, hidden);
      },
    });
    const last = await r.run();
    expect(swapped).toBe(true);
    expect(last?.type).toBe("result");
    expect(r.flags).toEqual(["record_mismatch"]);
    expect(usageSum(r.events)).toBe(3010); // the echo's m2 and m3 were metered, not only the file's m1
  });

  it("a recorder killed with SIGKILL leaves no trailer: the run is a failure, flagged, and the echo's replay is still taken", async () => {
    const r = portRig({ stdout: [assistant("m1")], endless: true });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    const { hookFired } = r.port.startDetached(handle, r.opts());
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    r.vm.killRecorder();
    const last = await hookFired;
    expect(last).toMatchObject({ type: "error", isError: true });
    expect(r.flags).toEqual(["record_trailer_missing"]);
    expect(r.vm.log.filter((e) => e.kind === "agent_logs")).toEqual([expect.objectContaining({ exited: true })]);
  });

  it("a command that dies with exit 98 after it wrote records and no trailer is a cut-off run, never a launch refusal", async () => {
    const r = portRig({ stdout: [assistant("m1")], endless: true });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    const { hookFired } = r.port.startDetached(handle, r.opts());
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    r.vm.killRecorder(0, 98);
    expect(await hookFired).toMatchObject({ type: "error" });
    expect(r.flags).toEqual(["record_trailer_missing"]);
  });

  it("a missing trailer is never a clean end, even when wait() says exit 0 and the last line is a result", async () => {
    const r = portRig({ stdout: [assistant("m1"), result()], endless: true });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    const { hookFired } = r.port.startDetached(handle, r.opts());
    await vi.waitFor(() => expect(r.events.length).toBe(2));
    r.vm.killRecorder(0, 0);
    expect(await hookFired).toMatchObject({ type: "error", isError: true });
    expect(r.flags).toEqual(["record_trailer_missing"]);
  });

  it("a trailer whose exit code is not the one wait() reports is flagged, though the echo and the file agree", async () => {
    const r = portRig({ stdout: [assistant("m1"), result()] }, { waitExit: 137 });
    const last = await r.run();
    expect(r.flags).toEqual(["record_mismatch"]);
    expect(last).toMatchObject({ type: "error" }); // wait() says 137: not a success
  });

  it("a trailer while the command is still running is a forgery: the run is killed and flagged, never ended by it", async () => {
    const r = portRig({ stdout: [assistant("m1")], endless: true });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    const { hookFired } = r.port.startDetached(handle, r.opts());
    const failed = hookFired.catch((e: unknown) => e);
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    r.vm.append(REC, frameRecord({ s: 2, k: "x", code: 0, sig: null, lines: 1, bytes: 5 }));
    expect(await failed).toBeInstanceOf(SandboxPortError);
    expect(r.flags).toEqual(["record_file_tampered"]);
    expect(r.vm.log.some((e) => e.kind === "agent_kill")).toBe(true);
  });

  it("a launch refusal is told by the echo (no header, no trailer), whatever the exit code", async () => {
    const r = portRig({ stdout: [assistant("m1")] });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    r.vm.setFile(REC, Buffer.from("planted by an earlier command"));
    const last = await r.port.startDetached(handle, r.opts()).hookFired;
    expect(r.vm.log.find((e) => e.kind === "agent_refused")).toMatchObject({ exitCode: 98 });
    expect(last).toMatchObject({ type: "error", isError: true });
    expect(r.flags).toEqual(["record_launch_refused"]);
    expect(r.events).toEqual([]);
    expect(r.vm.file(REC)!.toString()).toBe("planted by an earlier command");
  });

  it("a child that itself exits 98 is NOT a refusal: its header and trailer are in the echo", async () => {
    const child = portRig({ stdout: [assistant("m1")], exit: 98 });
    const last = await child.run();
    expect(last).toMatchObject({ type: "error", isError: true });
    expect(child.flags).toEqual([]);
    expect(child.vm.log.some((e) => e.kind === "agent_refused")).toBe(false);
    expect(child.events).toHaveLength(1);
  });

  it("the file's trailer must agree with wait(): a trailer for another exit code is flagged", async () => {
    let swapped = false;
    const r = portRig({ stdout: [assistant("m1")], exit: 7 }, {
      onRead: (path, vm) => {
        if (swapped || !acceptRecords(vm.file(path) ?? Buffer.alloc(0), 0).trailer) return;
        swapped = true;
        vm.setFile(path, recordFile(RUN, [assistant("m1").trim()], { code: 0, sig: null }));
      },
    });
    await r.run();
    expect(r.flags).toContain("record_mismatch");
  });

  it("three head violations in a row mean the file was rewritten under the reader: flagged, killed, failed", async () => {
    let done = false;
    const r = portRig({ stdout: [assistant("m1"), assistant("m2")], endless: true }, {
      onRead: (path, vm) => {
        const f = vm.file(path);
        if (done || !f || acceptRecords(f, 0).records.length < 3) return;
        done = true;
        const at = f.indexOf(0x0a) + 12; // inside the second record
        const bad = Buffer.from(f);
        bad[at] = bad[at] === 0x5a ? 0x59 : 0x5a;
        vm.setFile(path, bad);
      },
    });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    await expect(r.port.startDetached(handle, r.opts()).hookFired).rejects.toBeInstanceOf(SandboxPortError);
    expect(r.flags).toEqual(["record_file_tampered"]);
  });

  it("a file cut below the committed offset is tampering at once", async () => {
    const r = portRig({ stdout: [assistant("m1"), assistant("m2")], endless: true });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    const failed = r.port.startDetached(handle, r.opts()).hookFired.catch((e: unknown) => e);
    await vi.waitFor(() => expect(r.events.length).toBe(2));
    r.vm.setFile(REC, r.vm.file(REC)!.subarray(0, 10));
    expect(await failed).toBeInstanceOf(SandboxPortError);
    expect(r.flags).toEqual(["record_file_tampered"]);
  });

  it("a file past its size ceiling is flagged log_oversize and the run is failed", async () => {
    let done = false;
    const r = portRig({ stdout: [assistant("m1")], endless: true }, {
      onRead: (path, vm) => {
        if (done) return;
        done = true;
        vm.setFile(path, Buffer.alloc(200 * 1024 * 1024 + 1));
      },
    });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    await expect(r.port.startDetached(handle, r.opts()).hookFired).rejects.toBeInstanceOf(SandboxPortError);
    expect(r.flags).toEqual(["log_oversize"]);
  });

  it("three failed reads in a row while the command runs: flagged reader_unavailable, killed, failed", async () => {
    const r = portRig({ stdout: [assistant("m1")], endless: true }, { readExit: 1 });
    const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    await expect(r.port.startDetached(handle, r.opts()).hookFired).rejects.toBeInstanceOf(SandboxPortError);
    expect(r.flags).toEqual(["reader_unavailable"]);
    expect(r.vm.log.filter((e) => e.kind === "read")).toHaveLength(3);
  });

  it("an over-long line (a `big` record) ends the run as it did before: counted as oversize, killed", async () => {
    const invalid: string[] = [];
    const r = portRig({ stdout: ["x".repeat(1_048_577) + "\n"] });
    const big = scriptedSandbox({ stdout: ["x".repeat(1_048_577) + "\n"] });
    const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: recordingSdk({ create: async () => big, get: async () => big }), reader: { probeMs: 20 }, onInvalidEvent: (x) => void invalid.push(x) });
    const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    await expect(port.startDetached(handle, r.opts()).hookFired).rejects.toMatchObject({ operation: "stdout line cap" });
    expect(invalid).toEqual(["oversize"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Fix round 1: the cross-check on every exit, a tolerant echo parse, an unreadable echo is not a clean end, and a reader that survives a rotated token.

const M1 = assistant("m1", 10);
const M2 = assistant("m2", 1000);
const M3 = assistant("m3", 2000);
const HIDDEN_TOTAL = 3010;

/** The file as read, with records hidden from its unread part: the first time the file shows the whole run it is replaced by the header and `m1` only; every later read runs `then`. */
function hidingFile(then: (path: string, vm: RecordingVm) => void = () => undefined): NonNullable<RecordingVmOptions["onRead"]> {
  let step = 0;
  return (path, vm) => {
    const f = vm.file(path);
    if (!f) return;
    if (step === 0 && acceptRecords(f, 0).records.length >= 4) {
      step = 1;
      const hidden = recordFile(RUN, [M1.trim()]);
      vm.setFile(path, hidden.subarray(0, hidden.lastIndexOf(0x0a, hidden.length - 2) + 1)); // the header and m1, no trailer
    } else if (step >= 1) {
      step = 2;
      then(path, vm);
    }
  };
}

const startRun = async (r: ReturnType<typeof portRig>, over: Partial<StartDetachedOptions> = {}) => {
  const handle = await r.port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
  return { handle, hookFired: r.port.startDetached(handle, r.opts(over)).hookFired };
};

/** Every sandbox the SDK hands out answers an agent command through `fn` (the recorder's command, never a read). */
function onAgentCommand(sdk: VercelSandboxSdk & { vm: RecordingVm }, fn: (c: SdkCommand) => SdkCommand): VercelSandboxSdk {
  const wrap = (sb: SdkSandbox): SdkSandbox =>
    new Proxy(sb, {
      get(target, prop) {
        if (prop === "runCommand") {
          return async (params: Parameters<SdkSandbox["runCommand"]>[0]): Promise<SdkCommand> => {
            const c = await target.runCommand(params);
            return params.args?.[1] === PROMPT_WRAPPER ? fn(c) : c;
          };
        }
        return Reflect.get(target, prop, target) as unknown;
      },
    });
  return { create: async (p) => wrap(await sdk.create(p)), get: async (p) => wrap(await sdk.get(p)) };
}

describe("RLR-3b a reader fault still runs the echo cross-check", () => {
  const faults: Array<[string, ReaderFlag, (path: string, vm: RecordingVm) => void]> = [
    ["a record file cut below the committed offset", "record_file_tampered", (path, vm) => vm.setFile(path, Buffer.alloc(0))],
    ["a file past its size ceiling", "log_oversize", (path, vm) => vm.setFile(path, Buffer.alloc(200 * 1024 * 1024 + 1))],
    ["a file whose next record is refused, read after read", "record_file_tampered", (path, vm) => vm.setFile(path, Buffer.concat([vm.file(path)!, Buffer.from("not a record\n")]))],
    ["a file that cannot be read, read after read", "reader_unavailable", (path, vm) => void vm.files.delete(path)],
  ];
  for (const [name, flag, fault] of faults) {
    it(`${name}: usage held back from the unread part of the file is metered from the echo`, async () => {
      const r = portRig({ stdout: [M1, M2, M3], endless: true }, { onRead: hidingFile(fault) });
      const { hookFired } = await startRun(r);
      await expect(hookFired).rejects.toBeInstanceOf(SandboxPortError);
      expect(r.flags).toContain(flag);
      expect(usageSum(r.events)).toBe(HIDDEN_TOTAL);
      expect(r.vm.logsBeforeExit()).toBe(0);
      expect(r.vm.log.filter((e) => e.kind === "agent_logs")).toEqual([expect.objectContaining({ exited: true })]); // one replay, after the exit
    });
  }

  it("a stop takes the replay: the run ends undefined and the hidden usage is metered", async () => {
    const r = portRig({ stdout: [M1, M2, M3], endless: true }, { onRead: hidingFile() });
    const { handle, hookFired } = await startRun(r);
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    await r.port.stop(handle);
    await expect(hookFired).resolves.toBeUndefined();
    expect(usageSum(r.events)).toBe(HIDDEN_TOTAL);
    expect(r.vm.logsBeforeExit()).toBe(0);
  });

  it("a command that does not exit after the kill is waited for only so long: no replay, the flag is raised and the fault is what the caller sees", async () => {
    const stuck = (c: SdkCommand): SdkCommand => ({
      cmdId: c.cmdId,
      logs: () => c.logs(),
      wait: (o) => new Promise((_, reject) => o?.signal?.addEventListener("abort", () => reject(o.signal!.reason), { once: true })),
      kill: async () => undefined,
    });
    const r = portRig({ stdout: [M1, M2, M3], endless: true }, { onRead: hidingFile((path, vm) => vm.setFile(path, Buffer.alloc(0))) }, { exitWaitMs: 60 }, { wrapSdk: (sdk) => onAgentCommand(sdk, stuck) });
    const t0 = Date.now();
    const { hookFired } = await startRun(r);
    await expect(hookFired).rejects.toBeInstanceOf(SandboxPortError);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.flags).toEqual(expect.arrayContaining(["record_file_tampered", "reader_unavailable"]));
    expect(r.vm.log.filter((e) => e.kind === "agent_logs")).toEqual([]); // never replayed a command that had not exited
  });
});

describe("RLR-3b the echo parse does not stop at a line it refuses", () => {
  const rec = (o: Record<string, unknown>): string => frameRecord(o).toString("latin1");
  const line = (seq: number, id: string, tokens: number): Record<string, unknown> => ({ s: seq, k: "o", n: Buffer.byteLength(assistant(id, tokens).trim()), d: assistant(id, tokens).trim() });
  const replay = (chunks: string[]): SdkCommand => ({ logs: () => (async function* () { for (const data of chunks) yield { stream: "stdout", data }; })(), wait: async () => ({ exitCode: 0 }), kill: async () => undefined });
  const fileOf = (...records: Array<Record<string, unknown>>) => {
    const l = new RecordLedger();
    for (const r of records) l.add(acceptRecords(frameRecord(r), r.s as number).records[0]!);
    return { ledger: l, trailer: null };
  };
  const head = { s: 0, k: "h", run: RUN, v: 1 };
  const names = (only: AcceptedRecord[]): string[] => only.map((r) => (JSON.parse(r.data.toString()) as { message: { id: string } }).message.id);

  it("a line in the stream that is no record is skipped: the records after it are still compared, handed over and counted as a difference", async () => {
    const only: AcceptedRecord[] = [];
    const check = await crossCheckEcho(replay([rec(head), "junk without a check value\n", rec(line(1, "m1", 10)), rec(line(2, "m2", 1000))]), fileOf(head, line(1, "m1", 10)), { onEchoOnly: async (r) => void only.push(r) });
    expect(names(only)).toEqual(["m2"]);
    expect(check).toMatchObject({ unavailable: false, mismatch: true, hasHeader: true });
  });

  it("a junk line split across chunks, and one made of non-ASCII bytes, change nothing for the lines after them", async () => {
    const only: AcceptedRecord[] = [];
    const m2 = rec(line(2, "m2", 1000));
    const check = await crossCheckEcho(replay([rec(head), "ju", "nk\n", "ééé\n", m2.slice(0, 20), m2.slice(20), rec(line(3, "m3", 2000))]), fileOf(head), { onEchoOnly: async (r) => void only.push(r) });
    expect(names(only)).toContain("m2");
    expect(names(only)).toContain("m3");
    expect(check.mismatch).toBe(true);
  });

  it("a forged record that repeats a seq does not hide the real one: both are metered when the file has neither, and the forgery alone when the file has the real one", async () => {
    const forged = line(1, "forged", 5);
    const real = line(1, "m1", 10);
    const lacking: AcceptedRecord[] = [];
    await crossCheckEcho(replay([rec(head), rec(forged), rec(real), rec(line(2, "m2", 1000))]), fileOf(head), { onEchoOnly: async (r) => void lacking.push(r) });
    expect(names(lacking).sort()).toEqual(["forged", "m1", "m2"]);
    const having: AcceptedRecord[] = [];
    const check = await crossCheckEcho(replay([rec(head), rec(forged), rec(real), rec(line(2, "m2", 1000))]), fileOf(head, real), { onEchoOnly: async (r) => void having.push(r) });
    expect(names(having).sort()).toEqual(["forged", "m2"]);
    expect(check.mismatch).toBe(true);
    // the other order: the real record first, the forgery after it
    const after: AcceptedRecord[] = [];
    await crossCheckEcho(replay([rec(head), rec(real), rec(forged), rec(line(2, "m2", 1000))]), fileOf(head), { onEchoOnly: async (r) => void after.push(r) });
    expect(names(after).sort()).toEqual(["forged", "m1", "m2"]);
  });

  it("an over-long partial line is dropped up to its newline instead of ending the replay, and memory stays bounded", async () => {
    const only: AcceptedRecord[] = [];
    const check = await crossCheckEcho(replay([rec(head), "x".repeat(RECORD_READ_CAP + 10), "x".repeat(100) + "\n", rec(line(1, "m1", 10))]), fileOf(head), { onEchoOnly: async (r) => void only.push(r) });
    expect(names(only)).toEqual(["m1"]);
    expect(check.mismatch).toBe(true);
  });

  it("a replay of the recorder's own echo is still clean: no difference from the file", async () => {
    const { vm, cmd } = await fnRig({ stdout: [M1, M2, result()] });
    await settled(cmd);
    const file = acceptRecords(vm.file(REC)!, 0);
    const l = new RecordLedger();
    for (const r of file.records) l.add(r);
    expect(await crossCheckEcho(cmd, { ledger: l, trailer: file.trailer }, { onEchoOnly: async () => undefined })).toMatchObject({ unavailable: false, mismatch: false, count: file.records.length });
  });
});

describe("RLR-3b an echo that cannot be read is not a clean end", () => {
  const brokenEcho = (failures: number) => {
    const attempts = { n: 0 };
    const fn = (c: SdkCommand): SdkCommand => ({
      cmdId: c.cmdId,
      logs: () => {
        attempts.n++;
        return attempts.n <= failures ? (async function* () { throw new Error("stream lost"); })() : c.logs();
      },
      wait: (o) => c.wait(o),
      kill: () => c.kill(),
    });
    return { attempts, fn };
  };

  it("a replay that fails is tried once more: a second attempt that reads is a normal end, with nothing flagged", async () => {
    const b = brokenEcho(1);
    const r = portRig({ stdout: [M1, result()] }, {}, {}, { wrapSdk: (sdk) => onAgentCommand(sdk, b.fn) });
    const last = await r.run();
    expect(b.attempts.n).toBe(2);
    expect(last?.type).toBe("result");
    expect(r.flags).toEqual([]);
  });

  it("a replay that fails twice fails the run: the flag stays, the metered usage is what the file showed, and the end is an error, not a success", async () => {
    const b = brokenEcho(2);
    const r = portRig({ stdout: [M1, result()] }, {}, {}, { wrapSdk: (sdk) => onAgentCommand(sdk, b.fn) });
    const last = await r.run();
    expect(b.attempts.n).toBe(2);
    expect(last).toMatchObject({ type: "error", isError: true });
    expect(r.flags).toEqual(["reader_unavailable"]);
    expect(usageSum(r.events)).toBe(10);
  });

  it("an echo that reads but differs, after a complete replay, may still succeed, with the flag", async () => {
    let swapped = false;
    const r = portRig({ stdout: [M1, M2, result()] }, {
      onRead: (path, vm) => {
        if (swapped || !acceptRecords(vm.file(path) ?? Buffer.alloc(0), 0).trailer) return;
        swapped = true;
        vm.setFile(path, recordFile(RUN, [M1.trim(), result().trim()]));
      },
    });
    const last = await r.run();
    expect(last?.type).toBe("result");
    expect(r.flags).toEqual(["record_mismatch"]);
  });

  it("a replay that takes the whole bound leaves no time for a second one: one attempt, and the run fails", async () => {
    let attempts = 0;
    const slow = (c: SdkCommand): SdkCommand => ({
      cmdId: c.cmdId,
      logs: () => {
        attempts++;
        return (async function* () {
          await new Promise<never>(() => undefined);
        })();
      },
      wait: (o) => c.wait(o),
      kill: () => c.kill(),
    });
    const r = portRig({ stdout: [M1, result()] }, {}, { echoTimeoutMs: 80 }, { wrapSdk: (sdk) => onAgentCommand(sdk, slow) });
    const last = await r.run();
    expect(attempts).toBe(1);
    expect(last).toMatchObject({ type: "error" });
    expect(r.flags).toEqual(["reader_unavailable"]);
  });

  it("a first attempt that fails with only a sliver of the bound left gets no second one (clock injected, no timer precision involved)", async () => {
    const bound = 10_000;
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    let attempts = 0;
    const lateFail = (c: SdkCommand): SdkCommand => ({
      cmdId: c.cmdId,
      logs: () => {
        attempts++;
        skew = bound - 5; // by the time this attempt ends, all but 5 ms of the bound is gone
        return (async function* () { throw new Error("stream lost"); })();
      },
      wait: (o) => c.wait(o),
      kill: () => c.kill(),
    });
    try {
      const r = portRig({ stdout: [M1, result()] }, {}, { echoTimeoutMs: bound }, { wrapSdk: (sdk) => onAgentCommand(sdk, lateFail) });
      const last = await r.run();
      expect(attempts).toBe(1);
      expect(last).toMatchObject({ type: "error" });
      expect(r.flags).toEqual(["reader_unavailable"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("RLR-3b the drain after the exit tolerates transient read failures", () => {
  const failing = (times: number): NonNullable<RecordingVmOptions["onRead"]> => {
    let n = 0;
    let kept: { content: Buffer; mode: number } | undefined;
    return (path, vm) => {
      kept ??= vm.files.get(path);
      n++;
      if (n <= times) vm.files.delete(path);
      else if (kept && !vm.files.has(path)) vm.files.set(path, kept);
    };
  };

  it("fewer failed reads in a row than the limit, then a good one: the trailer is read and the run ends normally", async () => {
    const r = portRig({ stdout: [M1, result()] }, { onRead: failing(READ_FAILURE_LIMIT) });
    const last = await r.run();
    expect(last?.type).toBe("result");
    expect(r.flags).toEqual([]);
    expect(usageSum(r.events)).toBe(10);
  });

  it("as many failed reads in a row as the limit, after the exit: the trailer is given up on and the run is cut off", async () => {
    const r = portRig({ stdout: [M1, result()] }, { onRead: failing(10) });
    const last = await r.run();
    expect(last).toMatchObject({ type: "error", isError: true });
    expect(r.flags).toEqual(["record_mismatch", "record_trailer_missing"]); // the echo has what the file never gave
    expect(usageSum(r.events)).toBe(10); // the echo still meters the line the file never gave
  });
});

describe("RLR-3b the reader across a rotated token", () => {
  /** The sandbox opened again after the rotation answers `getCommand` with a thin view of the command, so what is used through it can be told from the launch-time object. */
  function rotatingRig(over: { hang?: boolean; wrongId?: boolean } = {}) {
    let token = "tok-1";
    const used = { freshWait: 0, freshKill: 0, staleWaitAfter: 0, getCommandIds: [] as string[] };
    let rotated = false;
    const commands = new Map<string, SdkCommand>();
    const wrapSdk = (sdk: VercelSandboxSdk & { vm: RecordingVm }): VercelSandboxSdk => {
      const launch = (sb: SdkSandbox): SdkSandbox =>
        new Proxy(sb, {
          get(target, prop) {
            if (prop === "runCommand") {
              return async (params: Parameters<SdkSandbox["runCommand"]>[0]): Promise<SdkCommand> => {
                const c = await target.runCommand(params);
                if (params.args?.[1] !== PROMPT_WRAPPER) return c;
                const stale: SdkCommand = {
                  cmdId: c.cmdId,
                  logs: () => c.logs(),
                  wait: (o) => {
                    if (rotated) used.staleWaitAfter++;
                    return c.wait(o);
                  },
                  kill: () => c.kill(),
                };
                commands.set(c.cmdId!, c);
                return stale;
              };
            }
            return Reflect.get(target, prop, target) as unknown;
          },
        });
      const fresh = (sb: SdkSandbox): SdkSandbox =>
        new Proxy(sb, {
          get(target, prop) {
            if (prop === "currentSession") {
              return () => ({
                sessionId: target.currentSession().sessionId,
                getCommand: async (id: string): Promise<SdkCommand> => {
                  used.getCommandIds.push(id);
                  const c = commands.get(id)!;
                  return {
                    cmdId: over.wrongId ? "another" : c.cmdId,
                    logs: () => c.logs(),
                    wait: (o) => {
                      used.freshWait++;
                      return c.wait(o);
                    },
                    kill: () => {
                      used.freshKill++;
                      return c.kill();
                    },
                  };
                },
              });
            }
            return Reflect.get(target, prop, target) as unknown;
          },
        });
      return {
        create: async (p) => launch(await sdk.create(p)),
        get: async (p) => {
          if (p.token === "tok-2") {
            if (over.hang) return new Promise<never>(() => undefined);
            return fresh(await sdk.get(p));
          }
          return launch(await sdk.get(p));
        },
      };
    };
    return {
      used,
      wrapSdk,
      getToken: async () => token,
      rotate: () => {
        rotated = true;
        token = "tok-2";
      },
    };
  }

  it("after the token rotates the reader opens the sandbox again and uses the command it looks up by the same id, for its probes", async () => {
    const rot = rotatingRig();
    const r = portRig({ stdout: [M1], endless: true }, {}, {}, { getToken: rot.getToken, wrapSdk: rot.wrapSdk });
    const { handle, hookFired } = await startRun(r);
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    expect(rot.used.freshWait).toBe(0); // the launch-time object served the reader until now
    rot.rotate();
    await vi.waitFor(() => expect(rot.used.freshWait).toBeGreaterThan(2));
    const staleSince = rot.used.staleWaitAfter;
    await r.port.stop(handle);
    await expect(hookFired).resolves.toBeUndefined();
    expect(new Set(rot.used.getCommandIds)).toEqual(new Set([r.vm.agents[0]!.cmdId]));
    expect(rot.used.staleWaitAfter).toBe(staleSince); // never the launch-time object again
  });

  it("a lookup that answers a different command id is refused: the reader never probes it, and gives up as unavailable", async () => {
    const rot = rotatingRig({ wrongId: true });
    const r = portRig({ stdout: [M1], endless: true }, {}, {}, { getToken: rot.getToken, wrapSdk: rot.wrapSdk });
    const { hookFired } = await startRun(r);
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    rot.rotate();
    await expect(hookFired).rejects.toBeInstanceOf(SandboxPortError);
    expect(r.flags).toContain("reader_unavailable");
    expect(rot.used.freshWait).toBe(0);
  });

  it("a vendor that hangs when the sandbox is opened again does not hold the reader past its bound: reads count as failed and the run ends as unavailable", async () => {
    const rot = rotatingRig({ hang: true });
    const r = portRig({ stdout: [M1], endless: true }, {}, {}, { getToken: rot.getToken, wrapSdk: rot.wrapSdk, callTimeoutMs: 100 });
    const { hookFired } = await startRun(r);
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    rot.rotate();
    const t0 = Date.now();
    await expect(hookFired).rejects.toBeInstanceOf(SandboxPortError);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.flags).toContain("reader_unavailable");
  });

  it("a stop is not held by the reader's own lookup hanging", async () => {
    const over = { hang: true };
    const rot = rotatingRig(over);
    const r = portRig({ stdout: [M1], endless: true }, {}, {}, { getToken: rot.getToken, wrapSdk: rot.wrapSdk, callTimeoutMs: 60_000 });
    const { handle, hookFired } = await startRun(r);
    await vi.waitFor(() => expect(r.events.length).toBe(1));
    rot.rotate();
    await new Promise((resolve) => setTimeout(resolve, 100)); // the reader's own lookup is now hanging, and would be for a minute
    over.hang = false; // the provider's own calls answer; only the call already made stays hung
    const t0 = Date.now();
    await r.port.stop(handle);
    await hookFired.catch(() => undefined);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("RLR-3b a stray line in the recorder's stdout, mid-run", () => {
  it("does not stop the cross-check: usage the file no longer shows is still metered from the lines after it", async () => {
    let swapped = false;
    const held: { rig?: ReturnType<typeof portRig> } = {};
    const rig = (held.rig = portRig(
      {
        stdout: [],
        gen: async function* () {
          yield { stream: "stdout", data: M1 };
          await new Promise((resolve) => setTimeout(resolve, 5));
          held.rig!.vm.agents[0]!.feed.push("stdout", "text that is not a record\n"); // what anything with the recorder's uid can write to its stdout
          yield { stream: "stdout", data: M2 };
          yield { stream: "stdout", data: M3 };
          yield { stream: "stdout", data: result() };
        },
      },
      {
        onRead: (path, vm) => {
          if (swapped || !acceptRecords(vm.file(path) ?? Buffer.alloc(0), 0).trailer) return;
          swapped = true;
          vm.setFile(path, recordFile(RUN, [M1.trim(), result().trim()]));
        },
      },
    ));
    const last = await rig.run();
    expect(swapped).toBe(true);
    expect(last?.type).toBe("result");
    expect(rig.flags).toEqual(["record_mismatch"]);
    expect(usageSum(rig.events)).toBe(HIDDEN_TOTAL);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Fix round 2: an end the runner enforced (a limit, a spend kill, an over-long line) still counts what the file hid from the part it had consumed.

describe("RLR-3b an enforced end counts what the file hid, and nothing after the record that ended the run", () => {
  const C2 = assistant("c2", 1);
  const C3 = assistant("c3", 1);
  const FILL = Array.from({ length: 24 }, (_, i) => assistant(`f${i}`, 1));
  const POST = [assistant("post1", 5000), assistant("post2", 5000)];
  const BIG = "x".repeat(1_048_577);
  /** The file as read: from the first read on it shows `lines` (cheap stand-ins for m2 and m3) and no trailer, whatever the agent printed. */
  function showing(lines: string[]): NonNullable<RecordingVmOptions["onRead"]> {
    let swapped = false;
    return (path, vm) => {
      const f = vm.file(path);
      if (swapped || !f || acceptRecords(f, 0).records.length < 4) return;
      swapped = true;
      const whole = recordFile(RUN, lines.map((l) => l.trim()));
      vm.setFile(path, whole.subarray(0, whole.lastIndexOf(0x0a, whole.length - 2) + 1));
    };
  }
  const ids = (events: NormalizedEvent[]): string[] => events.map((e) => e.messageId ?? "");
  const lateAgent = (lines: string[], later: string[], afterMs: number): Script => ({
    stdout: [],
    endless: true,
    gen: async function* () {
      for (const l of lines) yield { stream: "stdout", data: l };
      await new Promise((resolve) => setTimeout(resolve, afterMs));
      for (const l of later) yield { stream: "stdout", data: l };
    },
  });
  const oneReplayAfterExit = (r: ReturnType<typeof portRig>): void => {
    expect(r.vm.logsBeforeExit()).toBe(0);
    expect(r.vm.log.filter((e) => e.kind === "agent_logs")).toEqual([expect.objectContaining({ exited: true })]);
  };
  /** What every enforced end must show: the hidden usage metered once, from the echo, without text; the flag; nothing after the ending record. */
  const expectHiddenCounted = (r: ReturnType<typeof portRig>): void => {
    const echoOnly = r.events.filter((e) => e.messageId === "m2" || e.messageId === "m3");
    expect(echoOnly.map((e) => e.messageId).sort()).toEqual(["m2", "m3"]);
    expect(echoOnly.every((e) => e.text === undefined && e.toolUses === undefined && e.agentOutput === undefined)).toBe(true);
    expect(usageSum(r.events)).toBeGreaterThanOrEqual(HIDDEN_TOTAL);
    expect(r.flags).toContain("record_mismatch");
    expect(ids(r.events).some((id) => id.startsWith("post"))).toBe(false);
    oneReplayAfterExit(r);
  };

  it("a model-call limit: usage hidden before the kill is metered from the echo and flagged; records after it stay unmetered", async () => {
    const r = portRig({ stdout: [M1, M2, M3, ...FILL, ...POST], endless: true }, { onRead: showing([M1, C2, C3, ...FILL, ...POST]) });
    const { hookFired } = await startRun(r, { limits: { ...RUN_LIMITS, maxModelCalls: 20 } });
    await expect(hookFired).rejects.toMatchObject({ limit: { kind: "model_calls" } });
    expectHiddenCounted(r);
    expect(ids(r.events)).toContain("f10"); // the part the reader consumed was delivered as before
    expect(ids(r.events)).not.toContain("f23");
  });

  it("a run-time limit: usage hidden before the kill is metered from the echo and flagged; records after it stay unmetered", async () => {
    const r = portRig(lateAgent([M1, M2, M3], POST, 1500), { onRead: showing([M1, C2, C3]) }, {}, { limits: { maxRunMs: 500 } });
    const { hookFired } = await startRun(r, { limits: undefined });
    await expect(hookFired).rejects.toMatchObject({ limit: { kind: "run_time" } });
    expectHiddenCounted(r);
  });

  it("a silence limit: usage hidden before the kill is metered from the echo and flagged; records after it stay unmetered", async () => {
    const r = portRig(lateAgent([M1, M2, M3], POST, 1500), { onRead: showing([M1, C2, C3]) }, {}, { limits: { meteringSilenceMs: 300 } });
    const { hookFired } = await startRun(r, { limits: undefined });
    await expect(hookFired).rejects.toMatchObject({ limit: { kind: "silence" } });
    expectHiddenCounted(r);
  });

  it("a kill thrown from the caller's own handler: usage hidden before it is metered from the echo and flagged; records after it stay unmetered", async () => {
    const r = portRig({ stdout: [M1, M2, M3, ...FILL, ...POST], endless: true }, { onRead: showing([M1, C2, C3, ...FILL, ...POST]) });
    const { hookFired } = await startRun(r, {
      onEvent: async (e) => {
        r.events.push(e);
        if (e.messageId === "c3") throw new Error("spend cap reached");
      },
    });
    await expect(hookFired).rejects.toThrow("spend cap reached");
    expectHiddenCounted(r);
    expect(ids(r.events)).not.toContain("f0"); // nothing after the record that ended the run was consumed
  });

  it("an over-long line: usage hidden before it is metered from the echo and flagged; records after it stay unmetered", async () => {
    const r = portRig({ stdout: [M1, M2, M3, BIG + "\n", ...POST], endless: true }, { onRead: showing([M1, C2, C3, BIG, ...POST]) });
    const { hookFired } = await startRun(r);
    await expect(hookFired).rejects.toMatchObject({ operation: "stdout line cap" });
    expectHiddenCounted(r);
  });

  it("an enforced end with nothing hidden meters only what was consumed and raises no flag", async () => {
    const r = portRig({ stdout: [M1, M2, M3, ...FILL, ...POST], endless: true });
    const { hookFired } = await startRun(r, { limits: { ...RUN_LIMITS, maxModelCalls: 20 } });
    await expect(hookFired).rejects.toMatchObject({ limit: { kind: "model_calls" } });
    expect(r.flags).toEqual([]);
    expect(ids(r.events).some((id) => id.startsWith("post"))).toBe(false);
    expect(ids(r.events)).not.toContain("f23");
    oneReplayAfterExit(r);
  });

  it("what is counted after an enforced end is usage only: a hidden result is not adopted and the guard does not see the hidden lines", async () => {
    const hiddenResult = JSON.stringify({ type: "result", is_error: false, result: "done", session_id: "s1", total_cost_usd: 0.5, usage: { input_tokens: 700, output_tokens: 1 } }) + "\n";
    const calls: number[] = [];
    const r = portRig({ stdout: [M1, hiddenResult, M3, ...FILL, ...POST], endless: true }, { onRead: showing([M1, C2, C3, ...FILL, ...POST]) });
    const { hookFired } = await startRun(r, { limits: { ...RUN_LIMITS, maxModelCalls: 20 }, onModelCalls: (n) => void calls.push(n) });
    await expect(hookFired).rejects.toMatchObject({ limit: { kind: "model_calls" } });
    const counted = r.events.filter((e) => e.type === "result");
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ costUsd: 0.5 });
    expect(counted[0]!.text).toBeUndefined();
    expect(counted[0]!.agentOutput).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(21); // the limit's own count: the hidden message m3 did not add to it
  });

  // Fix round 3: the end is decided from the state before the catch-up. A stop a handler issues while the hidden usage is counted does not change it.
  describe("the end is decided before the hidden usage is counted", () => {
    /** The kind of handler the target had: it books the usage, and once the total is over a line it stops the sandbox and throws. */
    const stoppingHandler = (r: ReturnType<typeof portRig>, handleOf: () => SandboxHandle, metas: Array<EventMeta | undefined>, thrown?: Error) =>
      async (e: NormalizedEvent, meta?: EventMeta): Promise<void> => {
        r.events.push(e);
        metas.push(meta);
        if (usageSum(r.events) > 500) {
          void r.port.stop(handleOf()).catch(() => undefined);
          throw thrown ?? new Error("a later kill from the handler");
        }
      };

    it("a limit end stays the limit end when counting the hidden usage makes the handler stop the sandbox", async () => {
      const r = portRig({ stdout: [M1, M2, M3, ...FILL, ...POST], endless: true }, { onRead: showing([M1, C2, C3, ...FILL, ...POST]) });
      const metas: Array<EventMeta | undefined> = [];
      const held: { handle?: SandboxHandle } = {};
      const started = await startRun(r, { limits: { ...RUN_LIMITS, maxModelCalls: 20 }, onEvent: stoppingHandler(r, () => held.handle!, metas) });
      held.handle = started.handle;
      await expect(started.hookFired).rejects.toMatchObject({ name: "RunLimitError", limit: { kind: "model_calls" } });
      expectHiddenCounted(r);
      expect(r.events.filter((e) => e.messageId === "m2" || e.messageId === "m3")).toHaveLength(2); // a throw for one counted record does not stop the next
      // Only the records counted after the end carry the mark.
      expect(metas.filter((m) => m?.meterOnly === true)).toHaveLength(2);
      expect(metas.filter((m) => m === undefined).length).toBe(metas.length - 2);
    });

    it.each(["spend cap reached", "model key rejected"])("an end the handler threw (%s) stays that end when counting the hidden usage makes it throw again", async (message) => {
      const r = portRig({ stdout: [M1, M2, M3, ...FILL, ...POST], endless: true }, { onRead: showing([M1, C2, C3, ...FILL, ...POST]) });
      const held: { handle?: SandboxHandle } = {};
      const metas: Array<EventMeta | undefined> = [];
      const later = stoppingHandler(r, () => held.handle!, metas, new Error("a later kill from the handler"));
      const started = await startRun(r, {
        onEvent: async (e, meta) => {
          if (e.messageId === "c3" && meta === undefined) {
            r.events.push(e);
            void r.port.stop(held.handle!).catch(() => undefined);
            throw new Error(message);
          }
          return later(e, meta);
        },
      });
      held.handle = started.handle;
      await expect(started.hookFired).rejects.toThrow(message);
      expectHiddenCounted(r);
    });

    it("an end that really was a stop stays a stop, and the hidden usage is still counted", async () => {
      const r = portRig({ stdout: [M1, M2, M3], endless: true }, { onRead: showing([M1, C2, C3]) });
      const { handle, hookFired } = await startRun(r);
      await vi.waitFor(() => expect(ids(r.events)).toContain("c3"));
      await r.port.stop(handle);
      await expect(hookFired).resolves.toBeUndefined();
      expect(usageSum(r.events)).toBeGreaterThanOrEqual(HIDDEN_TOTAL);
    });
  });
});
