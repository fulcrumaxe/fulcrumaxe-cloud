import { createChannelClient, type SessionChannel } from "../../src/engineHost/channelClient.js";
import { EVENTS_READ_MAX } from "../../src/engineHost/guestSession.js";
import { fakeChannel, type FakeChannel } from "./fakeChannel.js";

/**
 * The far end of an engine session's channel for the bridge's tests: three in-memory streams (`events`, `engine`, `outcomes`) answered with the guest's own contract for `events_read` (whole lines from a byte offset, at most EVENTS_READ_MAX bytes, `ends` the byte offset
 * past each line, `reset` when the file is shorter than `after`), and `command` answered with the name the guest would give. Everything goes through the real client's frames over an in-memory pair, so a test needs no socket.
 * What it cannot do: the guest's own file checks (owner, mode, links), which `guestSession.test.ts` covers on the real module.
 */
export interface FakeGuest {
  channel: SessionChannel;
  far: FakeChannel;
  streams: { events: Buffer; engine: Buffer; outcomes: Buffer };
  /** The signed commands the guest was handed, as it received them. */
  commands: unknown[];
  /** `events_read` requests, in order. */
  reads: Array<{ after: number; stream: string }>;
  /** While set, every request is answered by a peer that goes away without a word. */
  down: boolean;
  /** Replaces the name `command` answers with (a guest that names another command). */
  nameFor: ((command: { command_seq: number; command_id: string }) => string) | undefined;
  append(stream: "events" | "engine" | "outcomes", text: string | Buffer): void;
}

export function fakeGuest(): FakeGuest {
  const guest: FakeGuest = {
    channel: undefined as unknown as SessionChannel,
    far: undefined as unknown as FakeChannel,
    streams: { events: Buffer.alloc(0), engine: Buffer.alloc(0), outcomes: Buffer.alloc(0) },
    commands: [],
    reads: [],
    down: false,
    nameFor: undefined,
    append: (stream, text) => void (guest.streams[stream] = Buffer.concat([guest.streams[stream], Buffer.from(text)])),
  };
  guest.far = fakeChannel((header) => {
    if (guest.down) throw new Error("gone");
    if (header["op"] === "command") {
      guest.commands.push(header["command"]);
      const c = (header["command"] as { command: { command_seq: number; command_id: string } }).command;
      return { ok: true, name: guest.nameFor?.(c) ?? `${c.command_seq}-${c.command_id.toLowerCase()}` };
    }
    if (header["op"] !== "events_read") return { ok: false, code: "bad_request" };
    const stream = (header["stream"] ?? "events") as "events" | "engine" | "outcomes";
    const after = header["after"] as number;
    guest.reads.push({ after, stream });
    const file = guest.streams[stream];
    const reset = after > file.length;
    const from = reset ? 0 : after;
    const window = file.subarray(from, from + Math.min(file.length - from, EVENTS_READ_MAX));
    const whole = window.subarray(0, window.lastIndexOf(0x0a) + 1);
    let end = from;
    const ends = whole.toString("latin1").split("\n").slice(0, -1).map((raw) => (end += raw.length + 1));
    return { ok: true, lines: whole.toString("utf8").split("\n").slice(0, -1), ends, next: from + whole.length, reset };
  });
  guest.channel = createChannelClient(guest.far.connect);
  return guest;
}

export const INSTANCE_E = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
export const INSTANCE_H = "7c2d8e4f-3a1b-4c5d-8e6f-9a0b1c2d3e4f";
/** One valid engine event line (the engine's own stream), ending in a newline. */
export const engineLine = (seq: number, instance = INSTANCE_E, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ v: 1, engine_instance_id: instance, seq, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5, ...extra })}\n`;
/** One valid host event line (the host's stream). */
export const hostEventLine = (seq: number, instance = INSTANCE_H): string => `${JSON.stringify({ v: 1, engine_instance_id: instance, seq, ts: "2026-11-16T15:00:01.000Z", kind: "tick_started", tick_kind: "loop", outcome: "ok" })}\n`;
