/**
 * D#845 ON-14a: one stream of an engine session's events as the bridge's source: `events_read` over the session's channel instead of a file this process opens. The engine, the host and the command outcomes live in the guest; the runner
 * never opens one of those files. What it keeps is its own cursor (the same file, rules and acks as the file tail: `poll`, `ack`, `rewind`), whose offset is the byte offset in the guest's file.
 * Every judgment of a line (schema, redaction, sequence, instance, gaps, drops) is the file tail's own code, run over the lines the guest returned. A channel that cannot be read is an idle poll and one fixed log line, never an error.
 */
import { EngineTail, type PollResult } from "./tail.js";
import type { SessionChannel } from "../engineHost/channelClient.js";
import { EVENTS_READ_MAX } from "../engineHost/guestSession.js";

export type ChannelStream = "events" | "engine";
export interface ChannelTail {
  poll(): Promise<PollResult>;
  ack(seq: number | null): void;
  rewind(): void;
  currentInstance(): string | null;
}
export interface ChannelTailOptions {
  channel: Pick<SessionChannel, "eventsRead">;
  stream: ChannelStream;
  cursorPath: string;
  uid: number | undefined;
  secrets: () => readonly string[];
  /** Gets fixed text only. */
  log: (line: string) => void;
  isForeignInstance?: (instanceId: string) => boolean;
}

/** The lines as the bytes of the guest's file: a line that does not re-encode to the span its offsets say (it held invalid UTF-8) becomes a junk line of exactly that span, which the schema drops, so the offsets stay exact. */
function bytesOf(lines: readonly string[], ends: readonly number[], from: number): Buffer {
  // the offsets came from the guest: the client has already refused a reply wider than one read window, and this refuses it again BEFORE a byte is made, so a span of the guest's can never size an allocation past that window
  if (lines.length !== ends.length || (ends.length > 0 && (ends[0]! <= from || ends[ends.length - 1]! - from > EVENTS_READ_MAX))) throw new RangeError("offsets out of window");
  const parts: Buffer[] = [];
  let prev = from;
  lines.forEach((line, i) => {
    const span = ends[i]! - prev;
    if (!(span >= 1 && span <= EVENTS_READ_MAX)) throw new RangeError("span out of window");
    const own = Buffer.from(`${line}\n`);
    if (own.length === span) parts.push(own);
    else {
      const junk = Buffer.alloc(span, 0x23);
      junk[span - 1] = 0x0a;
      parts.push(junk);
    }
    prev = ends[i]!;
  });
  return Buffer.concat(parts);
}

export function createChannelTail(options: ChannelTailOptions): ChannelTail {
  const core = new EngineTail({ eventsPath: "", cursorPath: options.cursorPath, uid: options.uid, secrets: options.secrets, log: options.log, ...(options.isForeignInstance === undefined ? {} : { isForeignInstance: options.isForeignInstance }) });
  let down = false;
  return {
    poll: () =>
      core.pollRemote(async (after) => {
        try {
          const read = await options.channel.eventsRead(after, options.stream);
          down = false;
          return { bytes: bytesOf(read.lines, read.ends, read.reset ? 0 : after), reset: read.reset };
        } catch {
          // fx-swallow-ok: the failure's text could name the guest's paths; one fixed line, and the next poll asks again from the saved cursor
          if (!down) options.log("engine-bridge: an engine session's channel could not be read; trying again later");
          down = true;
          return undefined;
        }
      }),
    ack: (seq) => core.ack(seq),
    rewind: () => core.rewind(),
    currentInstance: () => core.currentInstance(),
  };
}
