/**
 * What may be printed about an error the code did not raise itself. A Playwright error message embeds the request
 * call log with every header (the bypass secret, the session cookie), so its text is never printed: only a fixed
 * notice and the error's class name, reduced to plain identifier characters.
 */
export function errorClassName(err: unknown): string {
  const name = err instanceof Error ? (err.constructor?.name || err.name) : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

/** The one line a capture prints for an unexpected failure. */
export function unexpectedFailure(command: string, err: unknown): string {
  return `${command}: failed unexpectedly (${errorClassName(err)}); details are withheld because they can contain credentials`;
}

/**
 * A process-level guard for a command that holds credentials: an unhandled rejection prints the fixed line and calls
 * `onReject`, never the error. Returns the handler (so a test can drive it without a real rejection) and a dispose.
 */
export function guardRejections(command: string, print: (line: string) => void, onReject: () => void): { handler: (reason: unknown) => void; dispose: () => void } {
  const handler = (reason: unknown): void => {
    print(unexpectedFailure(command, reason));
    onReject();
  };
  process.on("unhandledRejection", handler);
  return { handler, dispose: () => void process.off("unhandledRejection", handler) };
}
