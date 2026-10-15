import type { CliExit } from "./errors.js";
import { scrub, stripControl } from "./scrub.js";

export interface Writable {
  write(chunk: string): unknown;
}

/** The only writer: strips terminal control characters, scrubs every byte, and under --json keeps stdout to one envelope per call. */
export class Output {
  constructor(
    private readonly io: { stdout: Writable; stderr: Writable },
    readonly json: boolean,
    readonly debug: boolean,
  ) {}
  out(text: string): void {
    this.io.stdout.write(scrub(stripControl(text)));
  }
  err(text: string): void {
    this.io.stderr.write(scrub(stripControl(text)));
  }
  /** Human text on stdout; silent under --json. */
  say(text: string): void {
    if (!this.json) this.out(`${text}\n`);
  }
  /** Notes that are not results, on stderr; silent under --json so a script sees nothing but the envelope. */
  note(text: string): void {
    if (!this.json) this.err(`${text}\n`);
  }
  trace(text: string): void {
    if (this.debug) this.err(`debug: ${text}\n`);
  }
  success(data: unknown): void {
    if (this.json) this.out(`${JSON.stringify({ v: 1, data })}\n`);
  }
  failure(e: CliExit): void {
    if (this.json) {
      this.out(`${JSON.stringify({ v: 1, error: { code: e.code, message: e.message, exit: e.exit, ...(e.link === undefined ? {} : { link: e.link }) } })}\n`);
    } else {
      this.err(`error: ${e.message}\n`);
    }
  }
}
