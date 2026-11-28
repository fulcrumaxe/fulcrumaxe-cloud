/**
 * The daemon's client for fx-vmhelper's socket (D#587 B-2b-iii). One connection per request, so a slow `prepare` never queues a `list` behind it.
 * Frames are the helper's own: one JSON object and a newline out, one JSON line back. The reply is checked field by field; a reply that does
 * not fit, or a refusal code outside the helper's closed list, is a failure with a fixed message, and nothing the helper sent is echoed.
 */
import type { Duplex } from "node:stream";

export const HELPER_PROTOCOL = 1;
export const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const HELPER_CODES = ["bad_peer", "too_busy", "frame_timeout", "frame_too_large", "bad_frame", "unknown_verb", "bad_field", "bad_id", "bad_number", "over_cap", "unknown_sandbox", "unknown_template", "unknown_snapshot", "snapshot_mismatch", "unavailable", "internal"] as const;
export type HelperCode = (typeof HELPER_CODES)[number];

/** A refusal, or a reply that was not the protocol's. `code` is from the closed list, or one of the daemon's own for a reply that never came right. */
export class HelperError extends Error {
  constructor(readonly code: HelperCode | "bad_reply" | "timeout" | "unreachable") {
    super(`the sandbox helper answered: ${code}`);
    this.name = "HelperError";
  }
}

export interface PreparedReply { vsockDir: string; sandboxGid: number }
export interface HelperEntry extends PreparedReply { sandboxId: string; created?: number }
export interface PrepareParams { sandboxId: string; template: string; vcpus: number; memMb: number }

/** What the daemon needs of the helper; `createHelperClient` is the socket-backed one. */
export interface Helper {
  prepare(params: PrepareParams): Promise<PreparedReply>;
  start(sandboxId: string): Promise<PreparedReply>;
  destroy(sandboxId: string): Promise<void>;
  /** Writes a full snapshot and kills the VM (also when it fails); the sandbox stays prepared. Resolves with the bytes stored. */
  snapshot(sandboxId: string, snapshotId: string): Promise<{ snapshotBytes: number }>;
  /** Starts a prepared, stopped sandbox from a stored snapshot; answers like `start`. */
  resume(sandboxId: string, snapshotId: string): Promise<PreparedReply>;
  snapshotDelete(snapshotId: string): Promise<void>;
  list(): Promise<HelperEntry[]>;
}

const MAX_REPLY = 1 << 20;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function readLine(socket: Duplex, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(new HelperError("timeout")), timeoutMs);
    const finish = (err: HelperError | null, line?: string): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (err !== null) reject(err);
      else resolve(line ?? "");
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_REPLY) return finish(new HelperError("bad_reply")); // the bound first: a newline past it does not make the reply acceptable
      const all = Buffer.concat(chunks);
      const end = all.indexOf(0x0a);
      if (end >= 0) finish(null, all.subarray(0, end).toString("utf8"));
    };
    const onError = (): void => finish(new HelperError("unreachable"));
    const onClose = (): void => finish(new HelperError("bad_reply"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * How long a `snapshot` request may wait for its reply. It is its own bound because the helper writes the whole guest's RAM before it answers: on the
 * installed disk (11-27, real VM) that took 10 s and 18.6 s for a small guest and 39.3 s and 41.5 s for the engine session's guest, past the 30 s that
 * every other verb gets. A client that gave up at 30 s made the daemon destroy the VM in the middle of the write. Five minutes is about seven times the
 * slowest measured write and still ends: a helper that never answers is not waited on for ever.
 */
export const HELPER_SNAPSHOT_TIMEOUT_MS = 300_000;

export function createHelperClient(connect: () => Promise<Duplex>, timeoutMs = 30_000, snapshotTimeoutMs = HELPER_SNAPSHOT_TIMEOUT_MS): Helper {
  async function call(frame: Record<string, string | number>, waitMs = timeoutMs): Promise<Record<string, unknown>> {
    let socket: Duplex;
    try {
      socket = await connect();
    } catch {
      // fx-swallow-ok: a fixed code replaces the connect error, which carries the socket path
      throw new HelperError("unreachable");
    }
    try {
      const reply = readLine(socket, waitMs);
      socket.write(`${JSON.stringify(frame)}\n`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await reply);
      } catch (err) {
        if (err instanceof HelperError) throw err;
        // fx-swallow-ok: the parser's message could echo helper bytes
        throw new HelperError("bad_reply");
      }
      if (!isRecord(parsed) || typeof parsed["ok"] !== "boolean" || parsed["protocol"] !== HELPER_PROTOCOL) throw new HelperError("bad_reply");
      if (parsed["ok"] === false) throw new HelperError((HELPER_CODES as readonly unknown[]).includes(parsed["code"]) ? (parsed["code"] as HelperCode) : "bad_reply");
      return parsed;
    } finally {
      socket.destroy();
    }
  }
  const located = (r: Record<string, unknown>): PreparedReply => {
    if (typeof r["vsock_dir"] !== "string" || !isPositiveInt(r["sandbox_gid"])) throw new HelperError("bad_reply");
    return { vsockDir: r["vsock_dir"], sandboxGid: r["sandbox_gid"] };
  };
  return {
    prepare: async (p) => located(await call({ verb: "prepare", sandbox_id: p.sandboxId, template: p.template, vcpus: p.vcpus, mem_mb: p.memMb })),
    start: async (id) => located(await call({ verb: "start", sandbox_id: id })),
    destroy: async (id) => void (await call({ verb: "destroy", sandbox_id: id })),
    snapshot: async (id, snap) => {
      const bytes = (await call({ verb: "snapshot", sandbox_id: id, snapshot_id: snap }, snapshotTimeoutMs))["snapshot_bytes"];
      if (!isPositiveInt(bytes)) throw new HelperError("bad_reply");
      return { snapshotBytes: bytes };
    },
    resume: async (id, snap) => located(await call({ verb: "resume", sandbox_id: id, snapshot_id: snap })),
    snapshotDelete: async (snap) => void (await call({ verb: "snapshot_delete", snapshot_id: snap })),
    list: async () => {
      const rows = (await call({ verb: "list" }))["sandboxes"];
      if (!Array.isArray(rows)) throw new HelperError("bad_reply");
      return rows.map((row: unknown): HelperEntry => {
        if (!isRecord(row) || typeof row["sandbox_id"] !== "string" || !SANDBOX_ID.test(row["sandbox_id"])) throw new HelperError("bad_reply");
        const created = row["created"];
        if (created !== undefined && !isPositiveInt(created)) throw new HelperError("bad_reply");
        return { sandboxId: row["sandbox_id"], ...located(row), ...(created === undefined ? {} : { created }) };
      });
    },
  };
}
