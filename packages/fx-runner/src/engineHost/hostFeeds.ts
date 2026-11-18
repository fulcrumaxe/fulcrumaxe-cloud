/**
 * EB-12c: the two real feeds the host process has, both plain files of the engine's state directory, so no process has to be inside another.
 *
 *  - The OUT feed, `createEventSpool`: every event the host emits (`host_*`, `tick_started`, `tick_ended`, `compaction_detected`) is written as one line of
 *    `engine-host-events.jsonl`, already in the engine event shape (EB-1's `EngineEvent`, checked before it is written). The spool is a session of its own
 *    (a uuid made when the host process starts, `seq` counting from 0), the same way the bridge's own events are, so it never shares sequence numbers with the
 *    engine's. The file is 0600, opened without following a link, and rotated at 1 MiB to `.1` (older lines are lost, and the gap in `seq` shows it). The
 *    bridge's uploader (EB-3c) reads it and sends it; until it does, the file only grows to those two files.
 *  - The IN feed, `createAgentFeed`: the engine's `agent_started` and `agent_stopped` events, which settle a spawn or stop command (`ticks.ts`). It reads the
 *    engine's own events file read-only, from its end at the time of the first read (older lines are history, not news), one poll at a time, without following
 *    a link, only complete lines, each judged by the EB-1 schema. A file that is a link, of another user or open to others is read as nothing.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { EngineEvent } from "@fulcrumaxe/runner-protocol";
import { openHostLog, type HostLog } from "./hostFiles.js";
import type { HostEvent } from "./supervisor.js";
import type { AgentEvent, TickEvent } from "./ticks.js";

export const SPOOL_FILE = "engine-host-events.jsonl";
export const SPOOL_MAX_BYTES = 1024 * 1024;
export const ENGINE_EVENTS_FILE = "engine-events.jsonl";
const POLL_READ_MAX = 256 * 1024;
const LINE_MAX = 64 * 1024;
/** Stop reasons EB-1's `host_stopped` has no word for are left off the event (the field is optional). */
const WIRE_REASONS = new Set(["stopped_by_person", "halted", "crash_loop", "operate_off", "machine_shutdown"]);

export interface EventSpool {
  /** Writes one event. Never throws; false when it was not written (counted in `failed()`). */
  write(event: HostEvent | TickEvent): boolean;
  failed(): number;
  close(): void;
}

export function createEventSpool(deps: { dir: string; uid: number; now: () => number; newId?: () => string; maxBytes?: number }): EventSpool {
  const log: HostLog = openHostLog(deps.dir, deps.uid, deps.maxBytes ?? SPOOL_MAX_BYTES, SPOOL_FILE);
  const instance = (deps.newId ?? randomUUID)();
  let seq = 0;
  let failures = 0;
  return {
    write(event) {
      const rest: Record<string, unknown> = { ...event };
      if (event.kind === "host_stopped") {
        delete rest.reason;
        delete rest.survivors;
        if (WIRE_REASONS.has(event.reason)) rest.reason = event.reason;
      }
      const parsed = EngineEvent.safeParse({ v: 1, engine_instance_id: instance, seq, ts: new Date(deps.now()).toISOString(), ...rest });
      if (!parsed.success || !log.write(`${JSON.stringify(parsed.data)}\n`)) {
        failures++;
        return false;
      }
      seq++;
      return true;
    },
    failed: () => failures,
    close: () => log.close(),
  };
}

export interface AgentFeed {
  /** The agent events that arrived since the last call. Never throws. */
  poll(): AgentEvent[];
}

export function createAgentFeed(deps: { dir: string; uid: number; file?: string }): AgentFeed {
  const target = path.join(deps.dir, deps.file ?? ENGINE_EVENTS_FILE);
  let inode = -1;
  let offset = -1;
  let partial = "";
  const toAgentEvent = (line: string): AgentEvent | undefined => {
    if (line.length > LINE_MAX) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // fx-swallow-ok: a line that is not JSON is not an event; nothing of it is kept
      return undefined;
    }
    const e = EngineEvent.safeParse(raw);
    if (!e.success) return undefined;
    if (e.data.kind === "agent_started") return { kind: "agent_started", role: e.data.role, discussion: e.data.discussion };
    if (e.data.kind === "agent_stopped") return { kind: "agent_stopped", agent_id: e.data.agent_id };
    return undefined;
  };
  return {
    poll() {
      try {
        const st = lstatSync(target, { throwIfNoEntry: false });
        if (st === undefined || st.isSymbolicLink() || !st.isFile()) return [];
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const open = fstatSync(fd);
          if (!open.isFile() || open.uid !== deps.uid || (open.mode & 0o022) !== 0) return [];
          // The first look only finds the end; a different file or a shorter one (rotation, truncation) is read from its start.
          if (offset === -1) {
            inode = open.ino;
            offset = open.size;
            return [];
          }
          if (open.ino !== inode || open.size < offset) {
            inode = open.ino;
            offset = 0;
            partial = "";
          }
          const want = Math.min(open.size - offset, POLL_READ_MAX);
          if (want <= 0) return [];
          const buf = Buffer.alloc(want);
          const got = readSync(fd, buf, 0, want, offset);
          offset += got;
          const text = partial + buf.toString("utf8", 0, got);
          const lines = text.split("\n");
          partial = lines.pop() ?? "";
          if (partial.length > LINE_MAX) partial = "";
          const out: AgentEvent[] = [];
          for (const line of lines) {
            const e = toAgentEvent(line);
            if (e !== undefined) out.push(e);
          }
          return out;
        } finally {
          closeSync(fd);
        }
      } catch {
        // fx-swallow-ok: a file that cannot be read this time is read as nothing; the next poll tries again and no path or error text is kept
        return [];
      }
    },
  };
}
