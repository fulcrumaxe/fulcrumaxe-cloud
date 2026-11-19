/**
 * One detached command in a guest (D#587 B-2b-iii). Its shape is the slice of the Vercel SDK command the runner's port reads
 * (`cmdId`, `logs()`, `wait()`, `kill()`), so a later adapter maps it one to one.
 *
 * What the guest agent allows today decides two things, and both are stated here rather than hidden. The agent answers an exec only when the
 * process has ended, so `logs()` delivers each stream's bytes in order once the command ends, not while it runs. And the agent has no kill:
 * the command is started through a `sh` that records its pid (the agent makes it a session leader, so the pid is its process group), and
 * `kill` runs a second short exec that signals that group.
 *
 * The exit code is delivered once. Whatever ends the command first (the guest's answer, a kill that never reached a process, a kill that
 * could not be delivered) settles `wait()`; the later ones are ignored.
 */
import { randomBytes } from "node:crypto";
import type { GuestAgent } from "./guestAgent.js";

export type Signal = "SIGTERM" | "SIGKILL";
export interface LogChunk { stream: "stdout" | "stderr"; data: string }
export interface CommandSpec { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutS?: number }

const SIGNUMBER: Record<Signal, number> = { SIGTERM: 15, SIGKILL: 9 };
const RECORD_PID = 'echo $$ >"$1" && shift && exec "$@"';
const SIGNAL_GROUP = 'p=$1; i=0; while [ ! -s "$p" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; [ -s "$p" ] && kill -s "$2" -- "-$(cat "$p")"';

export class SandboxdCommand {
  readonly cmdId = randomBytes(8).toString("hex");
  private readonly pidFile = `/tmp/fx-cmd-${this.cmdId}.pid`;
  private sent = false;
  private killedWith: Signal | undefined;
  private result: { exitCode: number; stdout: Buffer; stderr: Buffer } | undefined;
  private readonly settled: Promise<{ exitCode: number }>;
  private settle!: (r: { exitCode: number }) => void;
  private fail!: (e: unknown) => void;

  constructor(private readonly agent: GuestAgent, private readonly spec: CommandSpec) {
    this.settled = new Promise((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    this.settled.catch(() => undefined);
  }

  get finished(): boolean { return this.result !== undefined || this.failed; }
  private failed = false;

  private end(exitCode: number, stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0)): void {
    if (this.finished) return;
    this.result = { exitCode, stdout, stderr };
    this.settle({ exitCode });
  }

  /** Resolves when the command is running in the guest (its request is written), or already over because a kill came first. Rejects if it could not be sent. */
  async start(): Promise<void> {
    if (this.killedWith !== undefined) return this.end(128 + SIGNUMBER[this.killedWith]);
    const spec = this.spec;
    const argv = ["/bin/sh", "-c", RECORD_PID, "sh", this.pidFile, spec.cmd, ...(spec.args ?? [])];
    let sentNow!: () => void;
    const sentAt = new Promise<void>((resolve) => (sentNow = resolve));
    const run = this.agent.runInGuest({ argv, ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }), ...(spec.env === undefined ? {} : { env: spec.env }), ...(spec.timeoutS === undefined ? {} : { timeoutS: spec.timeoutS }), onSent: () => {
      this.sent = true;
      sentNow();
      if (this.killedWith !== undefined) void this.deliver(this.killedWith); // a kill that came while the request was being written
    } });
    run.then(
      (r) => this.end(r.exit ?? (r.signal !== null ? 128 + r.signal : 124), r.stdout, r.stderr),
      (e: unknown) => {
        if (this.finished) return;
        this.failed = true;
        this.fail(e);
        sentNow();
      },
    );
    await sentAt;
    if (this.failed) await this.settled; // never sent: the same error reaches the caller of start
  }

  wait(): Promise<{ exitCode: number }> { return this.settled; }

  async *logs(): AsyncIterable<LogChunk> {
    await this.settled;
    const r = this.result;
    if (r === undefined) return;
    const text = (b: Buffer): string => b.toString("utf8");
    if (r.stdout.length > 0) yield { stream: "stdout", data: text(r.stdout) };
    if (r.stderr.length > 0) yield { stream: "stderr", data: text(r.stderr) };
  }

  /** A kill before the request was written ends the command without ever starting it; after, it signals the group in the guest. Safe to repeat. */
  async kill(signal: Signal = "SIGTERM"): Promise<void> {
    if (this.finished) return;
    this.killedWith ??= signal;
    if (this.sent) await this.deliver(signal); // before that, start() or the write's own callback acts on the flag
  }

  private async deliver(signal: Signal): Promise<void> {
    try {
      await this.agent.runInGuest({ argv: ["/bin/sh", "-c", SIGNAL_GROUP, "sh", this.pidFile, signal.slice(3)], timeoutS: 20 });
    } catch {
      // fx-swallow-ok: a kill that cannot be delivered ends the command here, so the caller is never left waiting on a guest that does not answer
      this.end(128 + SIGNUMBER[signal]);
    }
  }
}
