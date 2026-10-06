import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordAgentOutput, recordAgentOutputCapped } from "./runStatusWriter.js";

/** D#2 H14c-3-2c (CARRY-15, write side): what a run's assistant text becomes in `run_events`. The limits live here only. */
export const AGENT_OUTPUT_LIMITS = {
  /** At most this many UTF-8 bytes of one message are stored. */
  maxMessageBytes: 32 * 1024,
  /** At most this many `agent.output` rows per run. */
  maxRows: 1000,
  /** At most this many UTF-8 bytes of stored `agent.output` text per run. */
  maxRunBytes: 4 * 1024 * 1024,
  /** The read side shows a payload over 64 KiB as a marker: a stored payload (JSON-escaped) stays under this, leaving room for the wire frame. */
  maxPayloadJsonBytes: 64 * 1024 - 512,
  /** Writes queued behind a slow database before the stream waits for them. */
  maxQueued: 32,
  /** How long a full queue is waited on before the message is dropped (and counted), and how long finalize waits to flush. */
  backpressureTimeoutMs: 2000,
} as const;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

/** The JSON size of `{"text":"","truncated":true,"original_bytes":N}`, with room to spare. */
const PAYLOAD_FRAME_BYTES = 96;

/** UTF-8 bytes a character takes once JSON-escaped (jsonb::text and JSON.stringify agree on this set). */
function escapedBytes(ch: string, code: number): number {
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
  return ch === '"' || ch === "\\" ? 2 : utf8Bytes(code);
}
const utf8Bytes = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);

/**
 * Bounds one message. Over the per-message cap, or over what fits under the wire cap once JSON-escaped (32 KiB of
 * control characters escape to 192 KiB), the text is cut on a code-point boundary and stored with `truncated: true`
 * and `original_bytes` (UTF-8 length of the whole text). A NUL or lone surrogate (jsonb cannot hold either) becomes
 * U+FFFD. `storedBytes` counts against the per-run byte cap.
 */
export function boundAgentOutput(text: string): { payload: Record<string, unknown>; storedBytes: number } {
  const budget = AGENT_OUTPUT_LIMITS.maxPayloadJsonBytes - PAYLOAD_FRAME_BYTES;
  let out = "";
  let keptBytes = 0;
  let escaped = 0;
  for (const raw of text) {
    const rawCode = raw.codePointAt(0)!;
    const ch = rawCode === 0 || (rawCode >= 0xd800 && rawCode <= 0xdfff) ? "�" : raw;
    const code = ch.codePointAt(0)!;
    if (keptBytes + utf8Bytes(code) > AGENT_OUTPUT_LIMITS.maxMessageBytes || escaped + escapedBytes(ch, code) > budget) {
      return { payload: { text: out, truncated: true, original_bytes: Buffer.byteLength(text, "utf8") }, storedBytes: keptBytes };
    }
    out += ch;
    keptBytes += utf8Bytes(code);
    escaped += escapedBytes(ch, code);
  }
  return { payload: { text: out }, storedBytes: keptBytes };
}

/**
 * One run's `agent.output` writer. Messages are written one at a time in arrival order; a failed write is logged
 * (fixed text) and counted, never thrown. The per-run counters are seeded from the database on first use (one
 * bounded query), so a run resumed on another instance continues from what is stored, then counted in memory.
 */
export class AgentOutputRecorder {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private seeded = false;
  private rows = 0;
  private bytes = 0;
  private capped = false;
  droppedMessages = 0;
  droppedBytes = 0;
  failedWrites = 0;

  constructor(
    private readonly pool: Pool,
    private readonly accountId: string,
    private readonly runId: string,
    /** Test seam: the clock the bounded waits use. */
    private readonly timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as NodeJS.Timeout) },
  ) {}

  /** Waits for the write chain, at most `timeoutMs`; false when it timed out. */
  private async settled(): Promise<boolean> {
    let timer: unknown;
    const timeout = new Promise<false>((resolve) => (timer = this.timers.set(() => resolve(false), AGENT_OUTPUT_LIMITS.backpressureTimeoutMs)));
    try {
      return await Promise.race([this.chain.then(() => true), timeout]);
    } finally {
      this.timers.clear(timer);
    }
  }

  /**
   * Never rejects. Resolves at once unless `maxQueued` writes are already waiting; then it waits at most `timeoutMs`
   * and drops (counts, logs) the message rather than block. Callers must not await this on a spend-kill path.
   */
  async record(text: string): Promise<void> {
    if (text === "") return;
    if (this.queued >= AGENT_OUTPUT_LIMITS.maxQueued && !(await this.settled())) {
      this.droppedMessages += 1;
      this.droppedBytes += Buffer.byteLength(text, "utf8");
      console.warn("agent output: a message was dropped, the write queue is full");
      return;
    }
    this.queued += 1;
    this.chain = this.chain.then(() => this.write(text)).finally(() => void (this.queued -= 1));
  }

  /** Waits for every accepted message, then leaves the one `agent.output.capped` row if the cap dropped any. Never throws. */
  async finish(): Promise<void> {
    if (!(await this.settled())) return void console.warn("agent output: writes still pending at finalize");
    if (this.droppedMessages === 0) return;
    await recordAgentOutputCapped(this.pool, {
      accountId: this.accountId,
      runId: this.runId,
      droppedMessages: this.droppedMessages,
      droppedBytes: this.droppedBytes,
    }).catch((err: unknown) => {
      reportError(err, { stage: "run.agent_output_capped" });
      this.fail();
    });
  }

  private fail(): void {
    this.failedWrites += 1;
    console.warn("agent output: a run_events write failed");
  }

  private async seed(): Promise<void> {
    const { rows } = await withTenant(this.pool, this.accountId, (client) =>
      client.query<{ n: number; bytes: string }>(
        `SELECT count(*)::int AS n, coalesce(sum(octet_length(payload->>'text')), 0)::bigint AS bytes
           FROM run_events WHERE run_id = $1 AND kind = 'agent.output'`,
        [this.runId],
      ),
    );
    this.rows = rows[0]!.n;
    this.bytes = Number(rows[0]!.bytes);
    this.seeded = true;
  }

  private async write(text: string): Promise<void> {
    try {
      if (!this.seeded) await this.seed();
      const { payload, storedBytes } = boundAgentOutput(text);
      // Once a cap is hit it stays hit: a later, smaller message is not let through.
      if (this.capped || this.rows >= AGENT_OUTPUT_LIMITS.maxRows || this.bytes + storedBytes > AGENT_OUTPUT_LIMITS.maxRunBytes) {
        this.capped = true;
        this.droppedMessages += 1;
        this.droppedBytes += Buffer.byteLength(text, "utf8");
        return;
      }
      await recordAgentOutput(this.pool, { accountId: this.accountId, runId: this.runId, payload });
      this.rows += 1;
      this.bytes += storedBytes;
    } catch (err) {
      reportError(err, { stage: "run.agent_output" });
      this.fail();
    }
  }
}
