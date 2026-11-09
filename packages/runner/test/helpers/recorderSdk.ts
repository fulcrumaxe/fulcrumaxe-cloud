import { createHash } from "node:crypto";
import type { SdkCommand, SdkSandbox, VercelSandboxSdk } from "../../src/vercelSandboxPort.js";
import { PROMPT_WRAPPER } from "../../src/vercelSandboxPort.js";
import { FX_RECORDER_PATH, FX_RECORDER_SCRIPT, RECORDER_MAX_LINE_BYTES } from "../../src/agentConfig.js";
import { READ_SCRIPT } from "../../src/recordParser.js";

/**
 * D#2 RLR-3b: a strict stand-in for the part of `@vercel/sandbox` 3.5.1 the run-log reader touches, over a scripted "agent" (a plain SdkSandbox
 * fake whose agent command prints lines and exits). Added around such a fake by `recordingSdk`, it makes the sandbox behave as a VM does:
 *
 * - `writeFiles` keeps the files (and creates their parent directories, as the SDK's tar extraction does); `content` must be a string or Buffer.
 * - The agent command (`sh -c PROMPT_WRAPPER fx-agent <file> node <recorder> <recordPath> <runId> -- <cli...>`) is refused the way the VM refuses it:
 *   no prompt file is exit 97; no recorder script, or one whose bytes differ from `FX_RECORDER_SCRIPT`, is exit 1; no directory for the record file, or
 *   a file already at the path, is exit 98 with nothing recorded and nothing echoed (what a refused recorder leaves). Otherwise a recorder
 *   frames the scripted agent's stdout lines, in the real recorder's record format, into a growing file and echoes the same lines to the command's stdout.
 * - The agent command's `logs()` is a live stream of the echo; calling it before the command has exited is recorded (`logsBeforeExit`). `wait()` takes
 *   `{ signal }` as the SDK does (it throws the signal's reason when aborted first, which for `AbortSignal.timeout` is a `TimeoutError`). The command's
 *   `exitCode` property throws if read: the SDK leaves it null until a wait completes, so reading it is always a bug.
 * - A read command (`sh -c READ_SCRIPT fx-read <offset+1> <path> <cap>`) is checked argument by argument against the one script and its output is
 *   made the way the script makes it: `tail -c +N | head -c cap`, then a 0xff byte, `@` and the size taken after. The vendor decodes log bytes as UTF-8, so a
 *   chunk reaches the port as a string and the 0xff arrives as U+FFFD. Any other command goes to the scripted fake unchanged.
 *
 * Not faked: the vendor's chunk timing, rate limits, and a stream that ends in an `error` entry.
 */

const MAX_LINE = RECORDER_MAX_LINE_BYTES;
const SIGNUMS: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1 };

/** The recorder's record line for `o`, exactly as `FX_RECORDER_SCRIPT` writes it (the parity test compares the two over real runs). */
export function frameRecord(o: Record<string, unknown>): Buffer {
  const withT = { ...o, t: o.s };
  const p = JSON.stringify(withT).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).slice(0, -1);
  return Buffer.from(p + ',"c":"' + createHash("sha256").update(p, "latin1").digest("hex").slice(0, 16) + '"}\n', "latin1");
}

/** The records the recorder writes for `lines` (a line is without its newline; a `{tail}` is an unterminated last fragment), the header and a trailer first and last. */
export function recordFile(runId: string, lines: Array<string | Buffer | { tail: string }>, exit: { code: number | null; sig: string | null } = { code: 0, sig: null }): Buffer {
  const parts: Buffer[] = [frameRecord({ s: 0, k: "h", run: runId, v: 1 })];
  let seq = 0;
  let bytes = 0;
  for (const line of lines) {
    seq++;
    const tail = typeof line === "object" && !Buffer.isBuffer(line);
    const buf = tail ? Buffer.from(line.tail) : Buffer.isBuffer(line) ? line : Buffer.from(line);
    bytes += buf.length + (tail ? 0 : 1);
    if (!tail && buf.length > MAX_LINE) parts.push(frameRecord({ s: seq, k: "big", n: buf.length }));
    else {
      const str = buf.toString("utf8");
      const clean = Buffer.byteLength(str, "utf8") === buf.length && !str.includes("�");
      parts.push(frameRecord(clean ? { s: seq, k: tail ? "tail" : "o", n: buf.length, d: str } : { s: seq, k: tail ? "tail" : "o", n: buf.length, e: "b64", d: buf.toString("base64") }));
    }
  }
  seq++;
  parts.push(frameRecord({ s: seq, k: "x", code: exit.code, sig: exit.sig, lines: seq - 1, bytes }));
  return Buffer.concat(parts);
}

class Feed {
  readonly items: Array<{ stream: string; data: string }> = [];
  ended = false;
  private wake: (() => void) | undefined;
  push(stream: string, data: string): void {
    this.items.push({ stream, data });
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async *iterate(): AsyncGenerator<{ stream: string; data: string }, void, void> {
    for (let i = 0; ; ) {
      if (i < this.items.length) yield this.items[i++]!;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

export interface VmLogEntry {
  kind: "agent_started" | "agent_logs" | "agent_wait" | "agent_kill" | "read" | "read_logs" | "agent_refused" | "exit_code_read" | "sandbox_stop" | "get_command";
  cmdId?: string;
  /** agent_kill: the signal asked for. */
  sig?: string;
  /** agent_logs: whether the command had already exited when the subscriber attached. */
  exited?: boolean;
  /** agent_wait: whether a signal was passed, and how it ended. */
  signal?: boolean;
  outcome?: "exited" | "aborted";
  /** agent_refused: the exit code the VM answered. */
  exitCode?: number;
  /** read: the argument values. */
  offset?: number;
  path?: string;
  cap?: number;
}

export interface RecordingVmOptions {
  /** Bytes per `logs()` chunk of a read and of an echo replay. Default 8192. */
  chunkBytes?: number;
  /** Alters the data a read returns (before the size suffix), to model a lossy stream. */
  readFilter?: (data: Buffer, ctx: { offset: number; path: string }) => Buffer;
  /** A read command that exits with this code instead of 0, or never ends. */
  readExit?: number;
  readHangs?: boolean;
  /** The agent command's wait() answers this exit code whatever the recorder wrote (a recorder killed just after its trailer). */
  waitExit?: number;
  /** The recorder's child ignores SIGTERM, as a stuck agent does: only SIGKILL ends the command (the recorder's own 5 s escalation is not modelled here). */
  ignoreSigterm?: boolean;
  /** Called as each read command starts, before it looks at the file: where a test plays the agent that rewrites the record file. */
  onRead?: (path: string, vm: RecordingVm) => void;
  /** Awaited by each read command before its output is produced: where a test makes a step of the exit sequence slow. */
  readDelay?: (ctx: { offset: number; path: string }) => Promise<void> | void;
}

interface AgentCmd {
  cmdId: string;
  feed: Feed;
  exited: boolean;
  exitCode: number | undefined;
  kill: (sig: string) => void;
  /** The recorder process dies without a trailer. */
  die: (code?: number) => void;
}

export function createRecordingVm(opts: RecordingVmOptions = {}) {
  const files = new Map<string, { content: Buffer; mode: number }>();
  const dirs = new Set<string>(["/", "/fx", "/tmp", "/vercel", "/vercel/sandbox"]);
  const log: VmLogEntry[] = [];
  const agents: AgentCmd[] = [];
  /** The agent commands by id, for `session.getCommand` (a re-attach by a later invocation). */
  const commandsById = new Map<string, SdkCommand>();
  const chunkBytes = opts.chunkBytes ?? 8192;
  let cmdSeq = 0;
  let hold: Promise<void> | undefined;

  const parentsOf = (path: string): string[] => {
    const parts = path.split("/").filter(Boolean);
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) out.push("/" + parts.slice(0, i).join("/"));
    return out;
  };
  const abs = (p: string): string => (p.startsWith("/") ? p : `/vercel/sandbox/${p}`);

  function chunked(bytes: Buffer): string[] {
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkBytes) out.push(new TextDecoder("utf-8").decode(bytes.subarray(i, i + chunkBytes)));
    return out;
  }

  function finishedCommand(cmdId: string, entries: Array<{ stream: string; data: string }>, exitCode: number, extra: { hang?: boolean } = {}): SdkCommand {
    return {
      cmdId,
      logs: () =>
        (async function* () {
          for (const e of entries) yield e;
          if (extra.hang) await new Promise<never>(() => undefined);
        })(),
      wait: async () => {
        if (extra.hang) await new Promise<never>(() => undefined);
        return { exitCode };
      },
      kill: async () => undefined,
    };
  }

  function refused(code: number, why: string): SdkCommand {
    const cmdId = `cmd_${++cmdSeq}`;
    log.push({ kind: "agent_refused", cmdId, exitCode: code });
    return finishedCommand(cmdId, why ? [{ stream: "stderr", data: why }] : [], code);
  }

  async function startAgent(inner: SdkSandbox, params: Parameters<SdkSandbox["runCommand"]>[0]): Promise<SdkCommand> {
    const a = params.args!;
    const [promptFile, , recorder, recordPath, runId, sep, ...child] = [a[3]!, a[4]!, a[5]!, a[6], a[7], a[8], ...a.slice(9)];
    const prompt = files.get(promptFile);
    if (!prompt) return refused(97, "");
    files.delete(promptFile); // the wrapper opens it on fd 3 and deletes it
    const script = files.get(recorder);
    if (!script || script.content.toString("utf8") !== FX_RECORDER_SCRIPT) return refused(1, "node: cannot find the recorder module\n");
    if (!recordPath || !runId || sep !== "--" || child.length === 0) return refused(96, "usage\n");
    if (!dirs.has(recordPath.slice(0, recordPath.lastIndexOf("/"))) || files.has(recordPath)) return refused(98, "recorder: cannot create the record file\n");

    const cmdId = `cmd_${++cmdSeq}`;
    const feed = new Feed();
    const file = { content: Buffer.alloc(0), mode: 0o600 };
    files.set(recordPath, file);
    let seq = 0;
    let total = 0;
    let finished = false;
    let resolveExit!: () => void;
    const exitedP = new Promise<void>((r) => (resolveExit = r));
    const cmd: AgentCmd = {
      cmdId,
      feed,
      exited: false,
      exitCode: undefined,
      kill: () => undefined,
      die: (code = 137) => {
        if (finished) return;
        finished = true;
        cmd.exitCode = code;
        cmd.exited = true;
        feed.end();
        resolveExit();
      },
    };
    agents.push(cmd);
    const emit = (o: Record<string, unknown>): void => {
      const line = frameRecord(o);
      file.content = Buffer.concat([file.content, line]);
      feed.push("stdout", line.toString("latin1"));
    };
    emit({ s: 0, k: "h", run: runId, v: 1 });
    const emitLine = (buf: Buffer, kind: "o" | "tail"): void => {
      seq++;
      if (kind === "o" && buf.length > MAX_LINE) return emit({ s: seq, k: "big", n: buf.length });
      const str = buf.toString("utf8");
      if (Buffer.byteLength(str, "utf8") === buf.length && !str.includes("�")) emit({ s: seq, k: kind, n: buf.length, d: str });
      else emit({ s: seq, k: kind, n: buf.length, e: "b64", d: buf.toString("base64") });
    };
    const finish = (code: number | null, sig: string | null, neverReported = false): void => {
      if (finished) return;
      finished = true;
      seq++;
      emit({ s: seq, k: "x", code, sig, lines: seq - 1, bytes: total });
      cmd.exitCode = code !== null ? code : sig ? 128 + (SIGNUMS[sig] ?? 1) : 1;
      feed.end();
      if (neverReported) return;
      cmd.exited = true;
      resolveExit();
    };

    // The scripted agent stands in for the CLI: the recorder reads its stdout, and forwards its stderr.
    const translated = { ...params, args: ["-c", PROMPT_WRAPPER, "fx-agent", promptFile, ...child] };
    const childCmd = await inner.runCommand(translated);
    log.push({ kind: "agent_started", cmdId });
    let killedBy: string | null = null;
    cmd.kill = (sig) => {
      killedBy ??= sig;
      finish(null, sig);
    };
    void (async () => {
      let pending = "";
      for await (const e of childCmd.logs()) {
        if (finished) return;
        if (typeof e.data !== "string") continue;
        if (e.stream === "stderr") {
          feed.push("stderr", e.data);
          continue;
        }
        total += Buffer.byteLength(e.data);
        pending += e.data;
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          emitLine(Buffer.from(pending.slice(0, nl)), "o");
          pending = pending.slice(nl + 1);
        }
      }
      if (finished) return;
      if (pending) emitLine(Buffer.from(pending), "tail");
      // A child whose exit the scripted agent never reports (a hung `wait`) is a child that ended while the control plane's wait did not return:
      // the recorder writes its trailer, and the command stays "running" for every wait() on it.
      const done = await Promise.race([childCmd.wait(), new Promise<undefined>((r) => setTimeout(r, 50, undefined))]);
      if (done === undefined) {
        finish(0, null, true);
        return;
      }
      finish(done.exitCode, null);
    })().catch(() => finish(1, null));

    const wait = (p?: { signal?: AbortSignal }): Promise<{ exitCode: number }> => {
      p?.signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          log.push({ kind: "agent_wait", cmdId, signal: true, outcome: "aborted" });
          reject(p!.signal!.reason);
        };
        p?.signal?.addEventListener("abort", onAbort, { once: true });
        void exitedP.then(() => {
          p?.signal?.removeEventListener("abort", onAbort);
          log.push({ kind: "agent_wait", cmdId, signal: p?.signal !== undefined, outcome: "exited" });
          resolve({ exitCode: opts.waitExit ?? cmd.exitCode! });
        });
      });
    };
    const command: SdkCommand = {
      cmdId,
      logs: () => {
        log.push({ kind: "agent_logs", cmdId, exited: cmd.exited });
        return feed.iterate();
      },
      wait,
      kill: async (sig: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
        log.push({ kind: "agent_kill", cmdId, sig });
        if (opts.ignoreSigterm && sig === "SIGTERM") return;
        await childCmd.kill();
        cmd.kill(sig);
      },
    };
    commandsById.set(cmdId, command);
    Object.defineProperty(command, "exitCode", {
      get() {
        log.push({ kind: "exit_code_read", cmdId });
        throw new Error("exitCode read: the SDK leaves it null until a wait() completes");
      },
    });
    return command;
  }

  function startRead(params: Parameters<SdkSandbox["runCommand"]>[0]): SdkCommand {
    const a = params.args!;
    const bad = (why: string): never => {
      throw new Error(`strict fake: a read command ${why}`);
    };
    if (a.length !== 6) bad("takes exactly six arguments");
    if (!/^[1-9][0-9]*$/.test(a[3]!)) bad("takes a positive decimal start byte");
    if (!/^[1-9][0-9]*$/.test(a[5]!)) bad("takes a positive decimal cap");
    if (params.env !== undefined && Object.keys(params.env).length > 0) bad("carries no environment");
    const cmdId = `cmd_${++cmdSeq}`;
    const offset = Number(a[3]) - 1;
    const path = a[4]!;
    const cap = Number(a[5]);
    log.push({ kind: "read", cmdId, offset, path, cap });
    opts.onRead?.(path, api);
    const file = files.get(path);
    let out: Buffer;
    if (!file) out = Buffer.from([0xff, 0x40]); // tail and stat fail quietly: no data, an empty size
    else {
      let data = file.content.subarray(offset, offset + cap);
      if (opts.readFilter) data = opts.readFilter(data, { offset, path });
      out = Buffer.concat([data, Buffer.from([0xff]), Buffer.from(`@${file.content.length}`)]);
    }
    let subscribers = 0;
    return {
      cmdId,
      logs: () => {
        subscribers++;
        log.push({ kind: "read_logs", cmdId });
        if (subscribers > 1) throw new Error("strict fake: a read command's output is read once");
        return (async function* () {
          await opts.readDelay?.({ offset, path });
          for (const data of chunked(out)) yield { stream: "stdout", data };
          if (opts.readHangs) await new Promise<never>(() => undefined);
        })();
      },
      wait: async () => ({ exitCode: opts.readExit ?? 0 }),
      kill: async () => undefined,
    };
  }

  function strictRun(params: Parameters<SdkSandbox["runCommand"]>[0]): void {
    const allowed = new Set(["cmd", "args", "cwd", "env", "sudo", "detached", "stdout", "stderr", "signal", "timeoutMs"]);
    for (const k of Object.keys(params)) if (!allowed.has(k)) throw new Error(`strict fake: runCommand takes no "${k}"`);
    if (typeof params.cmd !== "string" || params.cmd === "") throw new Error("strict fake: runCommand needs a cmd");
    if (params.args !== undefined && !(Array.isArray(params.args) && params.args.every((x) => typeof x === "string"))) throw new Error("strict fake: args are strings");
    if (params.env !== undefined && !Object.values(params.env).every((v) => typeof v === "string")) throw new Error("strict fake: env values are strings");
    if (params.detached !== true) throw new Error("strict fake: every command here is detached");
    params.signal?.throwIfAborted();
  }

  function wrap(inner: SdkSandbox): SdkSandbox {
    return new Proxy(inner, {
      get(target, prop) {
        if (prop === "runCommand") {
          return async (params: Parameters<SdkSandbox["runCommand"]>[0]): Promise<SdkCommand> => {
            strictRun(params);
            await hold;
            const a = params.args ?? [];
            if (params.cmd === "sh" && a[0] === "-c" && a[1] === PROMPT_WRAPPER) {
              if (a[2] !== "fx-agent" || a[4] !== "node" || a[5] !== FX_RECORDER_PATH) throw new Error("strict fake: the agent command runs under the recorder");
              return startAgent(target, params);
            }
            if (params.cmd === "sh" && a[0] === "-c" && a[1] === READ_SCRIPT && a[2] === "fx-read") return startRead(params);
            if (params.cmd === "sh" && a[0] === "-c" && a[2] === "fx-read") throw new Error("strict fake: a read command runs the one read script");
            return target.runCommand(params);
          };
        }
        if (prop === "currentSession") {
          // As the real session does: a command found by id (anything else is a 404), the same object a later invocation re-attaches to.
          return () => ({
            ...target.currentSession(),
            getCommand: async (cmdId: string, o?: { signal?: AbortSignal }): Promise<SdkCommand> => {
              o?.signal?.throwIfAborted();
              log.push({ kind: "get_command", cmdId });
              const found = commandsById.get(cmdId);
              if (!found) throw Object.assign(new Error("command not found"), { status: 404 });
              return found;
            },
          });
        }
        if (prop === "stop") {
          return async (o?: { signal?: AbortSignal }): Promise<unknown> => {
            log.push({ kind: "sandbox_stop" });
            return target.stop(o);
          };
        }
        if (prop === "writeFiles") {
          return async (list: Parameters<SdkSandbox["writeFiles"]>[0], o?: Parameters<SdkSandbox["writeFiles"]>[1]): Promise<void> => {
            for (const f of list) {
              if (typeof f.path !== "string" || f.path === "") throw new Error("strict fake: a file needs a path");
              if (typeof f.content !== "string" && !Buffer.isBuffer(f.content)) throw new Error("strict fake: file content is a string or a Buffer");
              if (f.mode !== undefined && (!Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o7777)) throw new Error("strict fake: a mode is an integer up to 0o7777");
            }
            await target.writeFiles(list, o);
            for (const f of list) {
              const path = abs(f.path);
              for (const d of parentsOf(path)) dirs.add(d);
              files.set(path, { content: Buffer.from(f.content), mode: f.mode ?? 0o644 });
            }
          };
        }
        return Reflect.get(target, prop, target) as unknown;
      },
    });
  }

  const api = {
    files,
    dirs,
    log,
    agents,
    wrap,
    /** Holds every command until `release()` (for tests that need the reader mid-flight). */
    holdCommands(): () => void {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return release;
    },
    /** The record file's bytes. */
    file(path: string): Buffer | undefined {
      return files.get(path)?.content;
    },
    setFile(path: string, content: Buffer): void {
      for (const d of parentsOf(path)) dirs.add(d);
      files.set(path, { content, mode: 0o600 });
    },
    /** What the agent command's subscribers did, by command. */
    logsBeforeExit(): number {
      return log.filter((e) => e.kind === "agent_logs" && e.exited === false).length;
    },
    /** A forged line at the end of the record file (an attacker with the agent's uid appends to it). */
    append(path: string, bytes: Buffer): void {
      const f = files.get(path)!;
      f.content = Buffer.concat([f.content, bytes]);
    },
    /** The agent command ended as if its recorder was killed with SIGKILL: no trailer, the command exits 137. */
    killRecorder(index = 0, exitCode = 137): void {
      agents[index]!.die(exitCode);
    },
  };
  return api;
}

export type RecordingVm = ReturnType<typeof createRecordingVm>;

/** The SDK `Sandbox` surface with every sandbox it hands out wrapped by `vm`. */
export function recordingSdk(inner: VercelSandboxSdk, vm: RecordingVm = createRecordingVm()): VercelSandboxSdk & { vm: RecordingVm } {
  return {
    vm,
    create: async (p) => vm.wrap(await inner.create(p)),
    get: async (p) => vm.wrap(await inner.get(p)),
    ...(inner.list && { list: inner.list.bind(inner) }),
  };
}
