/**
 * `fx-runner pause`, `resume` and the concurrency `config set` keys (D#6 C43-4). Pausing stops new claims at once and touches no running job;
 * the daemon looks for the marker before every claim and tells the cloud it is paused. The Repos card button is a later UI change.
 */
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import { isPaused, setPaused, setSetting, unsetSetting } from "../runnerSettings.js";

export function claimingCommand(verb: "pause" | "resume", ctx: CommandContext): number {
  const paused = verb === "pause";
  if (isPaused(ctx.stateDir) === paused) {
    ctx.out(paused ? "Claiming is already paused." : "Claiming is not paused.");
    return 0;
  }
  setPaused(ctx.stateDir, paused);
  ctx.out(paused ? "Claiming paused. Jobs already running finish; no new job is claimed until: fx-runner resume" : "Claiming resumed; the next claim takes jobs again.");
  return 0;
}

export function runnerUnsetCommand(key: string, ctx: CommandContext): number {
  ctx.out(unsetSetting(ctx.stateDir, key));
  return 0;
}

export function runnerSettingCommand(key: string, value: string | undefined, ctx: CommandContext): number {
  if (value === undefined) throw new CliError(`usage: fx-runner config set ${key} <number>`, 2);
  ctx.out(setSetting(ctx.stateDir, key, value));
  return 0;
}
