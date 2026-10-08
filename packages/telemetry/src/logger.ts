import { pickFields, sanitizeString } from "./fields.js";
import { isEventCode, type EventCode } from "./events.js";
import { VolumeCap } from "./volumeCap.js";

export type TelemetryLevel = "info" | "warn" | "error";
export type TelemetryFields = Readonly<Record<string, unknown>>;
export type LogFn = (event: EventCode, fields?: TelemetryFields) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  /** Write the `telemetry.dropped` line for every ended window that dropped events. */
  flush: () => void;
}

export interface LoggerOptions {
  service: string;
  /** Sink for one finished line (no trailing newline). Defaults to stdout. */
  write?: (line: string) => void;
  /** Clock in ms. Defaults to `Date.now`; tests pass a fake. */
  now?: () => number;
}

/** Events with no `account_id` share this one bucket. */
const UNATTRIBUTED = "";

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const service = sanitizeString(options.service);
  const cap = new VolumeCap(now);

  function line(level: TelemetryLevel, event: EventCode, fields: Record<string, string | number>): void {
    write(JSON.stringify({ ts: new Date(now()).toISOString(), level, service, event: sanitizeString(event), ...fields }));
  }

  function dropped(key: string, count: number): void {
    line("warn", "telemetry.dropped", key === UNATTRIBUTED ? { count } : { account_id: key, count });
  }

  function emit(level: TelemetryLevel, event: EventCode, input: TelemetryFields | undefined): void {
    try {
      const fields = pickFields(input);
      const key = typeof fields.account_id === "string" ? fields.account_id : UNATTRIBUTED;
      const count = cap.roll(key);
      if (count > 0) dropped(key, count);
      // warn and error are never dropped; only info is capped.
      if (level === "info" && !cap.admit(key)) return;
      // The type already forbids a free-text event; a value that got past it (a cast, plain JS) is not emitted.
      line(level, isEventCode(event) ? event : "telemetry.invalid_event", fields);
    } catch {
      // fx-swallow-ok: the logger is what reports, so a failure inside it has nowhere to go; the line is dropped
    }
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    flush: () => {
      for (const { key, dropped: count } of cap.drain()) {
        try {
          dropped(key, count);
        } catch {
          // fx-swallow-ok: a throwing sink costs this line only; the logger cannot report its own failure
        }
      }
    },
  };
}
