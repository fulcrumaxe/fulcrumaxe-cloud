/**
 * The two commands a tmux pane runs (D#6 R4a-7); neither is for typing by hand, so neither is in `--help`.
 *  - `__watch <run>`: renders the job's local transcript live (the renderer of `fx-runner logs`) until the job's record is gone. It never
 *    starts or signals the agent, so a crash of tmux or this pane cannot touch the job.
 *  - `__takeover <run>`: after the daemon has stopped the agent and recorded the take-over, resumes the agent's session interactively in the
 *    job's workspace, under the job's own settings and sandbox, with the person approving each action. Any API key comes from this
 *    program's own config (`credentialsOf`), into that one process's environment, never into tmux. The daemon pushes nothing for the run.
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import { loadRegistration } from "../config.js";
import type { CommandContext, Flags } from "../context.js";
import { cleanEnv } from "../job/cleanEnv.js";
import { clearTakeover, isRunId, readEntry, readLogFrom, removeEntry } from "../watch/layout.js";
import { renderLogRecord } from "./logs.js";
import { credentialsOf, localTools, type RunHost } from "./run.js";

const POLL_MS = 500;

function runIdOf(flags: Flags): string {
  const run = flags.get("run");
  if (typeof run !== "string" || !isRunId(run)) throw new CliError("expected a run id", 2);
  return run.toLowerCase();
}

export async function watchCommand(flags: Flags, ctx: CommandContext, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<number> {
  const runId = runIdOf(flags);
  const file = path.join(ctx.stateDir, "logs", `${runId}.jsonl`);
  let offset = 0;
  for (;;) {
    // Whether the job is over is read before the log, so the last lines it wrote are still shown.
    const over = readEntry(ctx.stateDir, runId) === undefined;
    const { text, next } = readLogFrom(file, offset);
    offset = next;
    for (const line of text.split("\n")) if (line !== "") for (const out of renderLogRecord(runId, line)) ctx.out(out);
    if (over) {
      ctx.out("The job has ended.");
      return 0;
    }
    await sleep(POLL_MS);
  }
}

export async function takeoverPaneCommand(flags: Flags, ctx: CommandContext, host: RunHost): Promise<number> {
  const runId = runIdOf(flags);
  const entry = readEntry(ctx.stateDir, runId);
  if (entry === undefined || entry.taken_over !== true) throw new CliError("take_over_not_handed: this run was not handed over to you", 1);
  const registration = loadRegistration(ctx.stateDir);
  if (!registration) throw new CliError("not registered; run: fx-runner register --code <code> --credential-mode <mode> --cloud-url <url>");
  const credentials = credentialsOf(registration);
  const { binaryPath, toolDirs } = localTools(host, cleanEnv(credentials).PATH ?? "");
  ctx.out("You have taken over this run. The agent was stopped and nothing more is sent to the cloud for it; the runner pushes nothing.");
  ctx.out("Commit and push with your own git when you are done. Each action asks for your approval.");
  try {
    return (await host.engine.takeOver({ binaryPath, credentials, envOptions: { extraPathDirs: toolDirs }, stateDir: ctx.stateDir, runId, role: entry.role })) ?? 1;
  } finally {
    removeEntry(ctx.stateDir, runId);
    clearTakeover(ctx.stateDir, runId);
  }
}
