import type { Bypass } from "./protectionBypass.js";

/** D#845 ON-3: what the device flow needs from the person's terminal. Only `bin/fx-runner.mjs` supplies it. */
export interface DeviceTerminal {
  /** Starts listening for Ctrl-C (call once per command); the signal is aborted when the person presses it. */
  signal: () => AbortSignal;
  /** Stops listening for Ctrl-C (called once the flow is over, before the service is started), so the default meaning of Ctrl-C is back. */
  release?: () => void;
  /** Asks one question on the terminal and returns the line typed ("" for a bare Enter), or undefined for Ctrl-C, a closed or non-terminal input, or a timeout. */
  askEnter: (question: string, signal: AbortSignal) => Promise<string | undefined>;
}

/** What a command needs from outside: the state directory, the two output streams, the clock and the network. */
export interface CommandContext {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  fetchFn: typeof fetch;
  /** Reads the registration code or token from standard input (no echo on a terminal). Only `bin/fx-runner.mjs` supplies it; `register --code-stdin` needs it. */
  readCode?: (() => Promise<string>) | undefined;
  /** What `FX_RUNNER_PROTECTION_BYPASS_FILE` came to (protectionBypass.ts). Commands that call the cloud pass its secret to the HTTP layer. */
  bypass?: Bypass | undefined;
  /** The path `FX_RUNNER_PROTECTION_BYPASS_FILE` names, as given (never the content). Only `service install` uses it, to carry the path into the unit. */
  bypassFile?: string | undefined;
  /** The user id the program runs as, looked up by the caller: the API key file and the directories above it must belong to it. */
  uid?: number | undefined;
  /** The machine's host name, looked up by the caller; `os.hostname()` when left out. Tests set it. */
  hostname?: string | undefined;
  /** Waits `ms` milliseconds; `assistant link` polls with it. Tests supply a fake clock's. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** The terminal the device flow asks its one question on (`setup`, and `register` with no code). */
  terminal?: DeviceTerminal | undefined;
}

/** The flags a command was given, by name without the leading dashes. A flag with no value is `true`. */
export type Flags = ReadonlyMap<string, string | true>;
