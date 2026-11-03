import { reportError } from "@fx/telemetry";
import { frame } from "../sse/views.js";
import type { TurnEvent } from "./turn.js";

/**
 * D#597 CC-5e: runs a turn and returns its events as SSE frames, once the FIRST event exists. A turn that fails before it
 * (an unknown conversation) throws, so the dispatcher answers with its ordinary JSON error envelope and no stream byte was sent.
 * Closing the body (the person pressing Stop, or leaving) aborts the turn's signal; the turn then settles what was used.
 * A failure after the stream began is reported (class only) and ends the stream with a fixed `error` event.
 */
export async function toSseFrames(run: (emit: (e: TurnEvent) => void, stop: AbortSignal) => Promise<void>, requestSignal: AbortSignal): Promise<AsyncIterable<string>> {
  const stop = new AbortController();
  const relay = () => stop.abort();
  if (requestSignal.aborted) stop.abort();
  requestSignal.addEventListener("abort", relay, { once: true });
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;
  const poke = () => {
    wake?.();
    wake = undefined;
  };
  const job = run((e) => {
    queue.push(frame({ event: e.event, data: e.data }));
    poke();
  }, stop.signal)
    .catch((err: unknown) => {
      failure = err ?? new Error("assistant turn failed");
    })
    .finally(() => {
      finished = true;
      poke();
    });
  const waitForMore = () => new Promise<void>((resolve) => (wake = resolve));
  while (queue.length === 0 && !finished) await waitForMore();
  if (queue.length === 0) {
    requestSignal.removeEventListener("abort", relay);
    throw failure ?? new Error("assistant turn produced nothing");
  }
  return (async function* () {
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (finished) break;
        await waitForMore();
      }
      if (failure !== undefined) {
        reportError(failure, { stage: "assistant.stream" });
        yield frame({ event: "error", data: { code: "internal_error" } });
      }
    } finally {
      stop.abort();
      requestSignal.removeEventListener("abort", relay);
      await job;
    }
  })();
}
