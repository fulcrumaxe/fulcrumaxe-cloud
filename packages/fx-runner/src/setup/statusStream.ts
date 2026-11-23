/**
 * D#845 ON-8d: the host's reader of the engine's status stream (Ruling 43 section C): the coldstart command's own stdout (`--status-fd 3 3>&1 1>&2`), read live; nothing is read after the run.
 * THREAT MODEL: the guest wrote every byte. A line counts only if complete (`\n`), at most 128 bytes, ASCII `step=<step> state=<state>[ code=<code>]` with every name from the engine's closed lists, at most 64 lines,
 * steps never going back (a resumed run may repeat an `ok` it already reported). Anything else refuses the whole stream: "stop" (the caller kills the command) and `setup_status_refused`. A partial last line is
 * dropped; nothing the guest printed is echoed.
 */
import { COLDSTART_STEPS, ColdstartCode, COLDSTART_STATES } from "@fulcrumaxe/runner-protocol";

export const MAX_STATUS_LINE_BYTES = 128;
export const MAX_STATUS_LINES = 64;
const LINE = /^step=([a-z_]+) state=([a-z]+)(?: code=([a-z0-9_:]+))?$/;

export type StatusStep = (typeof COLDSTART_STEPS)[number];
export interface StatusLine {
  step: StatusStep;
  state: (typeof COLDSTART_STATES)[number];
  code?: string;
}

/** `feed` takes one chunk and answers "stop" once the stream is refused (the command must be killed); `lines` are the accepted lines, in order. */
export interface StatusReader { feed(text: string): "stop" | undefined; readonly refused: boolean; readonly lines: readonly StatusLine[] }

export function createStatusReader(onLine: (line: StatusLine) => void): StatusReader {
  let buffer = "";
  let refused = false;
  let highest = -1;
  const accepted: StatusLine[] = [];
  const finished = new Set<StatusStep>();
  let failed = false;
  const parse = (text: string): StatusLine | undefined => {
    if (failed) return undefined; // nothing follows a failed line
    const match = text.match(LINE);
    const step = match?.[1] as StatusStep | undefined;
    const state = match?.[2] as StatusLine["state"] | undefined;
    const code = match?.[3];
    if (step === undefined || state === undefined || !(COLDSTART_STEPS as readonly string[]).includes(step) || !(COLDSTART_STATES as readonly string[]).includes(state)) return undefined;
    // the same rule the progress body holds: a failed step names its code, a started or finished one names none
    if (state === "failed" ? code === undefined : state !== "skipped" && code !== undefined) return undefined;
    if (code !== undefined && !ColdstartCode.safeParse(code).success) return undefined;
    // a skipped step names no code or exactly the one the engine skips for; a topic is named only by the failed line it belongs to, and is a short plain word
    if (state === "skipped" && code !== undefined && code !== "cloud_owned") return undefined;
    if (code?.includes(":") === true && (state !== "failed" || !/^missing_topic:[a-z][a-z0-9_]{0,31}$/.test(code))) return undefined;
    if (state === "failed") failed = true;
    const at = COLDSTART_STEPS.indexOf(step);
    if (at < highest && !(state === "ok" && finished.has(step))) return undefined;
    highest = Math.max(highest, at);
    if (state === "ok" || state === "skipped") finished.add(step);
    return { step, state, ...(code === undefined ? {} : { code }) };
  };
  return {
    get refused() {
      return refused;
    },
    lines: accepted,
    feed(text) {
      if (refused) return "stop";
      buffer += text;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const line = Buffer.byteLength(raw, "utf8") > MAX_STATUS_LINE_BYTES || accepted.length >= MAX_STATUS_LINES ? undefined : parse(raw);
        if (line === undefined) {
          refused = true;
          return "stop";
        }
        accepted.push(line);
        onLine(line);
      }
      // a line that is still open past the limit can never become a good one
      if (Buffer.byteLength(buffer, "utf8") > MAX_STATUS_LINE_BYTES) {
        refused = true;
        return "stop";
      }
      return undefined;
    },
  };
}
