import type { Bypass } from "./protectionBypass.js";

/** What a command needs from outside: the state directory, the two output streams, the clock and the network. */
export interface CommandContext {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  fetchFn: typeof fetch;
  /** What `FX_RUNNER_PROTECTION_BYPASS_FILE` came to (protectionBypass.ts). Commands that call the cloud pass its secret to the HTTP layer. */
  bypass?: Bypass | undefined;
  /** The path `FX_RUNNER_PROTECTION_BYPASS_FILE` names, as given (never the content). Only `service install` uses it, to carry the path into the unit. */
  bypassFile?: string | undefined;
  /** The user id the program runs as, looked up by the caller: the API key file and the directories above it must belong to it. */
  uid?: number | undefined;
}

/** The flags a command was given, by name without the leading dashes. A flag with no value is `true`. */
export type Flags = ReadonlyMap<string, string | true>;
