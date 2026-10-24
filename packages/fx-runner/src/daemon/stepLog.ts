/**
 * The runner's journal line per step of a run. A run that goes quiet is hard to tell from one that is working, so each step change says so on the runner's standard
 * output: the agent's turn starting and ending, the check starting and ending, and what the cloud answered to the run's end (`done`, or the `run_ended` event of a failure).
 *
 * Every line is built from fixed words, the run id (already printed when the run is claimed), numbers, and closed codes (a stop reason, a run-end reason, an HTTP
 * status). No path, no output text and no value from the repository or the agent goes into one, so there is nothing to redact: the check's own summary (the only free text
 * the runner reports) is redacted where it is built (`checkStep.ts`).
 */
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { DoneResult, EventsResult, HeartbeatResult, RunnerClient } from "./client.js";

/** One line to the runner's journal. */
export type StepSink = (line: string) => void;

/** The HTTP status the cloud's answer stands for: 0 when it could not be reached. */
export function httpStatusOf(reply: DoneResult | EventsResult | HeartbeatResult): number {
  switch (reply.kind) {
    case "ok":
    case "done":
      return 200;
    case "stop":
    case "seq_not_increasing":
      return 409;
    case "retry":
      return 503;
    default:
      return reply.status;
  }
}

/** A closed code, or `unknown` for anything else: only fixed words reach the journal. */
export const closedWord = (code: string | undefined): string => (code !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown");

/** The calls a run's lease and report make, each followed by one line saying what the cloud answered. The replies pass through untouched. */
export function observedClient(client: Pick<RunnerClient, "heartbeat" | "events" | "done">, step: StepSink): Pick<RunnerClient, "heartbeat" | "events" | "done"> {
  // Once the run's end has been posted, a stop answered to a heartbeat still in flight is the end itself coming back, not news: it is not written.
  let ended = false;
  return {
    heartbeat: async (runId, generation) => {
      const reply = await client.heartbeat(runId, generation);
      if (reply.kind === "stop" && !ended) step(`heartbeat answered stop (${closedWord(reply.reason)}, http ${String(httpStatusOf(reply))}); ending the run`);
      return reply;
    },
    events: async (runId, generation, events: readonly LocalOnlyEvent[]) => {
      const reply = await client.events(runId, generation, events);
      for (const event of events) if (event.type === "run_ended") ended = true;
      for (const event of events) if (event.type === "run_ended") step(`run_ended ${closedWord(event.reason)} posted (http ${String(httpStatusOf(reply))})`);
      return reply;
    },
    done: async (input) => {
      const reply = await client.done(input);
      ended = true;
      step(`done posted (http ${String(httpStatusOf(reply))})`);
      return reply;
    },
  };
}
