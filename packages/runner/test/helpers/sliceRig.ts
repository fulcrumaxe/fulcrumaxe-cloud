import { createUsageMeter, type RunLimits, type UsageMeterSnapshot } from "../../src/meteringGuard.js";
import { CLAUDE_CLI_VERSION, agentRecorderFiles, createVercelSandboxPort, recordPathFor, startAgentCommand, type SdkSandbox, type VercelSandboxSdk } from "../../src/vercelSandboxPort.js";
import { retentionPolicyFor } from "../../src/sandboxNaming.js";
import type { NormalizedEvent } from "../../src/types.js";
import type { EventMeta, ReaderFlag, ReadSliceOptions, SandboxHandle, SliceCheckpoint, StartDetachedOptions } from "../../src/sandboxPort.js";
import { buildSandboxEnv } from "../../src/sandboxEnv.js";
import { networkPolicy } from "../../src/networkPolicy.js";
import { keyedPolicy } from "./keyedPolicy.js";
import { sdkSessionStubs } from "./sdkSession.js";
import { createRecordingVm, recordingSdk, type RecordingVm, type RecordingVmOptions } from "./recorderSdk.js";

/**
 * D#2 RLR-4: a rig that runs the SAME scripted agent two ways over the strict recording VM: in-process (`startDetached`, the reader as one call) and in slices
 * (`readSlice`, the cursor and the saved state carried from one slice to the next through a JSON round trip, as the database would carry them). The
 * test side keeps what the caller keeps -- the usage meter, the delivered events -- so a sliced run and an in-process one can be compared figure by figure.
 */
export const SLICE_NAME = "rn-8-reviewer-run-1";
export const SLICE_RUN = "run-1";
export const SLICE_REC = recordPathFor(SLICE_RUN);
export const SLICE_LIMITS: Partial<RunLimits> = { maxTurns: 17, maxModelCalls: 40, maxRunMs: 9 * 60_000, meteringSilenceMs: 11 * 60_000 };

export const assistantLine = (id: string, tokens = 10, text = `text ${id}`): string =>
  JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }], usage: { input_tokens: tokens, output_tokens: 1 } } }) + "\n";
export const envelopeBlock = (verdict: string): string => "done\n<!-- AGENT_OUTPUT -->\n```json\n" + JSON.stringify({ verdict }) + "\n```\n<!-- /AGENT_OUTPUT -->";
export const resultLine = (text = "done", extra: Record<string, unknown> = {}): string => JSON.stringify({ type: "result", is_error: false, result: text, session_id: "s1", ...extra }) + "\n";

export interface SliceScript {
  /** The scripted agent's stdout, one chunk per line (a line carries its own newline). */
  lines: string[];
  exit?: number;
  /** The scripted agent never ends: its stdout stays open and its `wait` never returns. */
  endless?: boolean;
}

export function scriptedAgent(script: SliceScript, name = SLICE_NAME): SdkSandbox {
  return {
    name,
    async runCommand(params) {
      if (params.args?.[2] === "fx-pin") return { async *logs() { yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION} (Claude Code)\n` }; }, wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
      return {
        cmdId: "child",
        async *logs() {
          for (const l of script.lines) yield { stream: "stdout", data: l };
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

/** What a run is compared on: every figure a sliced run must reproduce. */
export interface RunShape {
  outcome: string;
  /** The delivered events, in order, as `id` for an assistant message and `type` otherwise (meter-only ones marked). */
  delivered: string[];
  total: number;
  rises: number;
  flags: string[];
  modelCalls: number | undefined;
  final: { type?: string; isError?: boolean; agentOutput?: unknown; sessionId?: string } | undefined;
}

export interface SliceRigOptions {
  script: SliceScript;
  vm?: RecordingVmOptions;
  limits?: Partial<RunLimits>;
  reader?: { probeMs?: number; trailerWaitMs?: number; echoTimeoutMs?: number; exitWaitMs?: number };
  /** The test's spend rule: once the metered total passes this, the handler stops the sandbox and throws (the target's spend kill). */
  stopAbove?: number;
  runId?: string;
  sandboxName?: string;
  /** Called once the agent command is started and nothing has been read, with the VM: where a test plays the agent. */
  afterStart?: (vm: RecordingVm) => void;
}

export interface SliceStore {
  cp?: SliceCheckpoint;
  usage?: UsageMeterSnapshot;
  total: number;
  rises: number;
  commits: number;
  delivered: string[];
  modelCalls?: number;
  /** The rows the sliced reader would have saved: the line each assistant text came from, in order. */
  rows: Array<{ sourceLine: number | undefined; text: string | undefined }>;
}

export function sliceRig(o: SliceRigOptions) {
  const runId = o.runId ?? SLICE_RUN;
  const name = o.sandboxName ?? SLICE_NAME;
  const vm = createRecordingVm(o.vm);
  const inner = scriptedAgent(o.script, name);
  const raw: VercelSandboxSdk = { create: async () => inner, get: async () => inner };
  const sdk = recordingSdk(raw, vm);
  const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, reader: { probeMs: 20, trailerWaitMs: 60, exitWaitMs: 40, ...o.reader } });
  const flags: ReaderFlag[] = [];
  const limits = { ...SLICE_LIMITS, ...o.limits };
  let handle!: SandboxHandle;
  const store: SliceStore = { total: 0, rises: 0, commits: 0, delivered: [], rows: [] };

  /** A new test-side handler: the usage meter continues from `snapshot`, every event is recorded, a spend rule may kill. */
  const handler = (meter: ReturnType<typeof createUsageMeter>, sink: SliceStore) => async (e: NormalizedEvent, meta?: EventMeta): Promise<void> => {
    sink.delivered.push((e.type === "assistant" ? (e.messageId ?? "assistant") : e.type) + (meta?.meterOnly ? "*" : ""));
    if (e.type === "assistant" && e.text) sink.rows.push({ sourceLine: meta?.sourceLine, text: e.text });
    if (e.usage) {
      const rise = meter.observeRise(e);
      if (rise) {
        sink.rises++;
        sink.total += rise.delta.inputTokens;
      }
    }
    if (o.stopAbove !== undefined && !meta?.meterOnly && sink.total > o.stopAbove) {
      void port.stop(handle).catch(() => undefined);
      throw new Error("spend kill from the target's meter");
    }
  };

  const shapeOf = (outcome: string, sink: SliceStore, final?: NormalizedEvent): RunShape => ({
    outcome,
    delivered: sink.delivered,
    total: sink.total,
    rises: sink.rises,
    flags: [...new Set(flags)].sort(),
    modelCalls: sink.modelCalls,
    final: final && { type: final.type, isError: final.isError, agentOutput: final.agentOutput, sessionId: final.sessionId },
  });

  async function create(): Promise<SandboxHandle> {
    handle = await port.createSandbox({ sandboxName: name, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    return handle;
  }

  /** The in-process run: `startDetached`, and what `hookFired` does. */
  async function inProcess(): Promise<RunShape> {
    await create();
    const sink: SliceStore = { total: 0, rises: 0, commits: 0, delivered: [], rows: [] };
    const meter = createUsageMeter();
    const opts: StartDetachedOptions = {
      runId,
      role: "code-reviewer",
      roleCard: "card",
      prompt: "go",
      model: "sonnet-5",
      capUsd: 5,
      networkPolicy: keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
      env: buildSandboxEnv("code-reviewer"),
      onEvent: handler(meter, sink),
      onReaderFlag: (f) => void flags.push(f),
      onModelCalls: (n) => (sink.modelCalls = n),
      limits,
    };
    const settled = await port.startDetached(handle, opts).hookFired.then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );
    if ("e" in settled) return shapeOf(`rejected:${(settled.e as Error).name}${settled.e instanceof Error && "limit" in settled.e ? ":" + String((settled.e as { limit: { kind: string } }).limit.kind) : ""}`, sink);
    return shapeOf(settled.v === undefined ? "stopped" : "ended", sink, settled.v);
  }

  /** Starts the agent command under the recorder in the VM, reading nothing. Returns its id. */
  async function startCommand(): Promise<string> {
    await create();
    const sandbox = await sdk.get({ name, teamId: "t", projectId: "p", token: "tok" });
    await sandbox.writeFiles([{ path: "/tmp/fx-prompt-1", content: "p", mode: 0o600 }, ...agentRecorderFiles()]);
    const cmd = await startAgentCommand(sandbox, { promptFile: "/tmp/fx-prompt-1", runId, agentArgv: ["claude", "-p"], env: {}, timeoutMs: 5000 });
    o.afterStart?.(vm);
    return cmd.cmdId!;
  }

  type SliceOutcome = { kind: "slice" } | { kind: "lost" } | { kind: "ended"; event: NormalizedEvent | undefined } | { kind: "rejected"; error: unknown };

  /** One slice, carrying everything from `store`; `over` replaces any option. */
  async function slice(cmdId: string, sink: SliceStore, over: Partial<ReadSliceOptions> & { gate?: (cp: SliceCheckpoint) => boolean | Promise<boolean> } = {}): Promise<SliceOutcome> {
    const { gate, ...rest } = over;
    const meter = createUsageMeter(sink.usage ? { restore: sink.usage } : undefined);
    const cp = sink.cp;
    const opts: ReadSliceOptions = {
      runId,
      role: "code-reviewer",
      model: "sonnet-5",
      limits,
      onEvent: handler(meter, sink),
      onReaderFlag: (f) => void flags.push(f),
      onModelCalls: (n) => (sink.modelCalls = n),
      cmdId,
      sessionId: "sess-1",
      cursor: cp ? { nextSeq: cp.nextSeq, byteOffset: cp.byteOffset, readFailures: cp.readFailures } : { nextSeq: 0, byteOffset: 0, readFailures: 0 },
      ...(cp && { restore: { guard: cp.guard, sideEffects: cp.sideEffects, reader: cp.reader } }),
      untilMs: Date.now() + 60_000,
      commit: async (c) => {
        sink.commits++;
        if (gate && !(await gate(c))) return false;
        // Through JSON, as the database carries it.
        sink.cp = JSON.parse(JSON.stringify(c)) as SliceCheckpoint;
        sink.usage = meter.snapshot();
        return true;
      },
      ...rest,
    };
    return port.readSlice!(handle, opts).then(
      (r): SliceOutcome => r,
      (error: unknown): SliceOutcome => ({ kind: "rejected", error }),
    );
  }

  /** All the slices of a run, `plan(i)` records each (undefined: to the end). */
  async function sliced(plan: (i: number) => number | undefined, sink: SliceStore = store, over: Partial<ReadSliceOptions> = {}): Promise<RunShape> {
    const cmdId = await startCommand();
    for (let i = 0; i < 500; i++) {
      const r = await slice(cmdId, sink, { maxRecords: plan(i), ...over });
      if (r.kind === "slice") continue;
      if (r.kind === "lost") return shapeOf("lost", sink);
      if (r.kind === "rejected") return shapeOf(`rejected:${(r.error as Error).name}${r.error instanceof Error && "limit" in r.error ? ":" + String((r.error as { limit: { kind: string } }).limit.kind) : ""}`, sink);
      return shapeOf(r.event === undefined ? "stopped" : "ended", sink, r.event);
    }
    throw new Error("sliceRig: a run did not end in 500 slices");
  }

  return { vm: vm as RecordingVm, port, store, flags, create, inProcess, startCommand, slice, sliced, shapeOf, handle: () => handle };
}
