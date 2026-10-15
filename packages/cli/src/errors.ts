/** The exit codes. `fx --help` prints this table and a test drives each row. */
export const EXIT = { ok: 0, unexpected: 1, usage: 2, auth: 3, notFound: 4, rateLimited: 5, sessionOnly: 6, network: 7, streamLimit: 8, permission: 9, refused: 10 } as const;

export const EXIT_TABLE: ReadonlyArray<readonly [number, string]> = [
  [0, "ok"],
  [1, "unexpected: a 5xx, an unreadable response, any other error"],
  [2, "usage: bad flag, argument or base URL, unknown profile"],
  [3, "auth: no token, a refused token, a token saved for another origin"],
  [4, "not found"],
  [5, "rate limited, after retries"],
  [6, "needs the workspace: not available to a token"],
  [7, "network: DNS, connect, TLS or timeout"],
  [8, "too many open streams, after retries"],
  [9, "permission: the token lacks a scope, or your role does not allow it"],
  [10, "refused: the action is not allowed in the current state"],
];

/** A failure with its exit code. `message` is fixed text or the API's own words; it never holds a token. */
export class CliExit extends Error {
  constructor(
    readonly exit: number,
    readonly code: string,
    message: string,
    readonly link?: string,
  ) {
    super(message);
  }
}

export const usage = (message: string): CliExit => new CliExit(EXIT.usage, "usage", message);
export const notSignedIn = (): CliExit => new CliExit(EXIT.auth, "not_signed_in", "not signed in: run `fx login` or set FX_TOKEN");
