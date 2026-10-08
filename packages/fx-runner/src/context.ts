/** What a command needs from outside: the state directory, the two output streams, the clock and the network. */
export interface CommandContext {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  fetchFn: typeof fetch;
}

/** The flags a command was given, by name without the leading dashes. A flag with no value is `true`. */
export type Flags = ReadonlyMap<string, string | true>;
