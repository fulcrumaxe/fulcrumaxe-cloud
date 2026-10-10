/**
 * Reads one secret from standard input (D#6 R5b-3). Piped input is read to its end. On a terminal the prompt goes to the error stream, echo is
 * switched off while the person types, and Enter or Ctrl-D ends the line; Ctrl-C cancels. At most `maxBytes + 3` bytes are accepted either way,
 * so a long or endless input is refused early. Nothing typed is ever written back to a stream.
 */
import { ApiKeyError } from "./credentials.js";
import { CliError } from "./cliError.js";

export interface SecretStream extends NodeJS.ReadableStream {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
}

export function readSecret(stream: SecretStream, say: (text: string) => void, maxBytes: number): Promise<string> {
  const limit = maxBytes + 3;
  const tty = stream.isTTY === true;
  if (tty && typeof stream.setRawMode !== "function") return Promise.reject(new CliError("cannot switch off the terminal's echo, so the key will not be read from it; pipe it on standard input instead", 2));
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error?: Error): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (tty) {
        stream.setRawMode!(false);
        say("\n");
      }
      stream.pause();
      if (error !== undefined) reject(error);
      else resolve(text);
    };
    const onData = (chunk: Buffer | string): void => {
      const piece = chunk.toString();
      if (!tty) {
        text += piece;
      } else {
        for (const char of piece) {
          if (char === "\r" || char === "\n" || char === "\u0004") return finish();
          if (char === "\u0003") return finish(new CliError("cancelled", 130));
          if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
          else text += char;
        }
      }
      if (Buffer.byteLength(text) > limit) finish(new ApiKeyError("api_key_format"));
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new CliError("standard input could not be read"));
    if (tty) {
      say("API key (what you type is not shown): ");
      stream.setRawMode!(true);
    }
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}
