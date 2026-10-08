/** A failure the command line reports to the user. The message is fixed text that never carries a secret or a server-supplied string. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
