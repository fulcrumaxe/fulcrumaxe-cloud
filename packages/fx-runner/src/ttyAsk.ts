/**
 * D#601 MEM-6: asks the person one question on their own terminal and returns the line they typed, or `undefined`.
 *
 * The answer comes from one place only: the terminal stream the program was started with (standard input), and only while that stream is a terminal. Any other
 * stream (a pipe, a file, a closed descriptor) is never read; the answer is `undefined`, which the caller counts as "no". `undefined` is also what a timeout, an
 * abort (Ctrl-C), a stream that ended before a line (Ctrl-D, a closed terminal) and a read error give, so none of them can be mistaken for a yes. A stream that has
 * already ended answers at once, so a later question does not wait out its time.
 *
 * Keys typed before the question is drawn are thrown away: the stream is read and discarded until it has been quiet for `DRAIN_QUIET_MS`, and only then is the
 * question drawn. The answer is a line typed after that.
 *
 * What keeps the agent out of this: it takes no argument but the terminal, the question, the time and the abort signal; the agent's program has a pipe of its own for
 * standard input and a session of its own (`--new-session`), so it holds no descriptor of this terminal. The question for a run is asked after that run's agent has
 * ended. Agents of OTHER runs may still be running when it is asked (the runner can run several at once), and they are isolated the same way; this function does not
 * depend on them being gone.
 *
 * The question is drawn exactly as given. The caller builds it from fixed words and text it has already checked to hold no control or format character, so
 * nothing in it can move the cursor, recolour the screen or rewrite what the person is reading.
 */
export interface TerminalIn extends NodeJS.ReadableStream {
  isTTY?: boolean | undefined;
  readableEnded?: boolean | undefined;
  destroyed?: boolean | undefined;
}

export const DRAIN_QUIET_MS = 100;

export function askOnTerminal(input: TerminalIn, write: (text: string) => void, question: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  if (input.isTTY !== true || input.readableEnded === true || input.destroyed === true || signal?.aborted === true) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let line = "";
    let settled = false;
    let drained = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (answer: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(quiet);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.off("close", onEnd);
      input.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer | string): void => {
      if (!drained) {
        // Typed ahead: thrown away, and the quiet period starts again.
        clearTimeout(quiet);
        quiet = setTimeout(draw, DRAIN_QUIET_MS);
        return;
      }
      line += chunk.toString();
      const newline = line.search(/[\r\n]/);
      if (newline !== -1) finish(line.slice(0, newline));
      else if (line.length > 256) finish(undefined);
    };
    const onEnd = (): void => finish(undefined);
    const onAbort = (): void => {
      if (drained) write("\n");
      finish(undefined);
    };
    function draw(): void {
      if (settled || drained) return;
      drained = true;
      timer = setTimeout(() => {
        write("\n");
        finish(undefined);
      }, timeoutMs);
      write(question);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
    input.on("close", onEnd);
    // Whatever the stream already holds is discarded, then it is read until it has been quiet.
    while (input.read() !== null) {
      /* discard */
    }
    clearTimeout(quiet);
    quiet = setTimeout(draw, DRAIN_QUIET_MS);
    input.resume();
  });
}
