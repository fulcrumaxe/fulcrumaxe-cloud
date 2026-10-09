/**
 * `fx-runner attach` (D#6 R4a-7): watch a running job on this machine, or take it over. It is observability for the machine's owner and
 * nothing more: the cloud has no message that starts, attaches to or types into a session, and only this OS user can reach the tmux
 * socket (a private directory, a 0600 socket, which `attach` checks before it goes near it).
 *
 *  - no argument: lists this machine's running jobs;
 *  - `<run | short id | --latest>`: attaches read-only (`tmux attach-session -r`);
 *  - `--take-over`: after the person types the run's short id, asks the daemon to stop the agent (SIGINT) and record the take-over, waits
 *    until the pane runs `fx-runner __takeover`, then attaches read-write. The daemon pushes nothing and uploads no result for that run.
 */
import { CliError } from "../cliError.js";
import type { CommandContext, Flags } from "../context.js";
import { cleanEnv } from "../job/cleanEnv.js";
import { isRunId, readEntries, requestTakeover, shortId, socketIsPrivate, takeoverState, clearTakeover, type WatchEntry } from "../watch/layout.js";
import { attachArgs, findTmux, hasSession, tmuxEnv, type TmuxConfig } from "../watch/tmux.js";
import type { RunHost } from "./run.js";

export const TAKEOVER_WAIT_MS = 60_000;
const TAKEOVER_POLL_MS = 250;

/** Replaceable by a test only: `runCli` never passes any. */
export interface AttachHooks {
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  /** The tmux binary, instead of the one found on the search path. */
  binary?: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The id the person typed, shown back in an error: letters, digits and dashes only, cut short. */
const shown = (text: string): string => text.replace(/[^A-Za-z0-9-]/g, "?").slice(0, 40);

function match(entries: readonly WatchEntry[], target: string): WatchEntry | undefined {
  const wanted = target.toLowerCase();
  const found = entries.filter((e) => e.run_id === wanted || shortId(e.run_id) === wanted || (wanted.length >= 4 && e.run_id.startsWith(wanted)));
  return found.length === 1 ? found[0] : undefined;
}

export async function attachCommand(flags: Flags, ctx: CommandContext, host: RunHost, hooks: AttachHooks = {}): Promise<number> {
  const searchPath = cleanEnv({ mode: "subscription" }).PATH ?? "";
  const home = host.home;
  const tmuxBinary = hooks.binary ?? findTmux(searchPath);
  const target = flags.get("run");
  const latest = flags.get("latest") === true;
  const takeOver = flags.get("take-over") === true;
  if (target !== undefined && typeof target !== "string") throw new CliError("attach takes a run id", 2);
  if (target !== undefined && latest) throw new CliError("give a run or --latest, not both", 2);
  if ((target === undefined && !latest) && takeOver) throw new CliError("--take-over needs a run or --latest", 2);

  const tmuxCfg: TmuxConfig | undefined =
    tmuxBinary === undefined || home === undefined ? undefined : { binary: tmuxBinary, stateDir: ctx.stateDir, capture: host.engine.capture, env: tmuxEnv({ home, path: searchPath, stateDir: ctx.stateDir, term: host.term }), selfCommand: [] };
  // A recorded job counts as running only while its tmux session is there; a record left by a daemon that died is not a job.
  const running: WatchEntry[] = [];
  for (const entry of readEntries(ctx.stateDir)) if (entry.taken_over !== true && tmuxCfg !== undefined && socketIsPrivate(ctx.stateDir, host.uid) && (await hasSession(tmuxCfg, entry.run_id))) running.push(entry);

  if (target === undefined && !latest) {
    if (running.length === 0) ctx.out("No running jobs on this machine.");
    else {
      ctx.out("ID        REPO                            ROLE              STARTED");
      for (const e of running) ctx.out(`${shortId(e.run_id)}  ${e.repo.padEnd(30)}  ${e.role.padEnd(16)}  ${e.started}`);
    }
    return 0;
  }
  const entry = latest ? running[running.length - 1] : match(running, target as string);
  if (entry === undefined || tmuxCfg === undefined) {
    const id = latest ? "--latest" : shown(target as string);
    throw new CliError(`No running job ${id} on this machine. See: fx-runner logs ${id}`, 2);
  }
  if (!isRunId(entry.run_id)) throw new CliError("the job record is damaged", 1);

  if (!takeOver) return (await host.engine.foreground(tmuxCfg.binary, attachArgs(ctx.stateDir, entry.run_id, true), tmuxCfg.env)) ?? 1;

  const short = shortId(entry.run_id);
  if (host.ask === undefined || host.interactive !== true) throw new CliError("--take-over needs a terminal: the confirmation must be typed");
  const answer = await host.ask(`This stops the agent working as ${entry.role} on ${entry.repo}. The run will be recorded as taken over, and no result will be sent to the cloud. Type ${short} to confirm: `);
  if (answer.trim().toLowerCase() !== short) throw new CliError("take_over_cancelled: the id did not match", 1);
  if (!requestTakeover(ctx.stateDir, entry.run_id)) throw new CliError("take_over_in_progress: a take-over of this job is already under way");

  const sleep = hooks.sleep ?? pause;
  const deadline = ctx.now().getTime() + (hooks.waitMs ?? TAKEOVER_WAIT_MS);
  ctx.out("Stopping the agent and recording the take-over...");
  for (;;) {
    if (takeoverState(ctx.stateDir, entry.run_id) === "ready") break;
    if (ctx.now().getTime() >= deadline) {
      throw new CliError("take_over_timeout: the runner did not hand the session over in time; the job may already have ended. Check: fx-runner status");
    }
    await sleep(TAKEOVER_POLL_MS);
  }
  const code = await host.engine.foreground(tmuxCfg.binary, attachArgs(ctx.stateDir, entry.run_id, false), tmuxCfg.env);
  clearTakeover(ctx.stateDir, entry.run_id);
  return code ?? 1;
}
