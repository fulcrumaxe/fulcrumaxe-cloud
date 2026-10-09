/**
 * `fx-runner update` and `fx-runner config` (D#6 R6-2b, correction C38 section 2).
 *
 *   update --check        the current and the available version, from the verified release metadata (installs nothing)
 *   update --pin <v>      hold that version; installs it now when it is not the one in use. A pin may name an older version
 *   update --unpin
 *   update --rollback     the kept previous version
 *   config set auto-update on|off
 *
 * The program that applies an update is `src/update/updater.ts`; this file is the words and the exit codes.
 */
import { CliError } from "../cliError.js";
import type { CommandContext, Flags } from "../context.js";
import { NOT_CONFIGURED_TEXT, TufClient, tufConfigured } from "../update/tuf.js";
import { BREW_LINE, Updater, isHomebrewPath, type UpdateHost, type UpdateResult } from "../update/updater.js";
import { compareVersions, loadUpdateState } from "../update/versions.js";

/** Replaceable by a test only: `runCli` never passes any. */
export interface UpdateHooks {
  tuf?: ConstructorParameters<typeof Updater>[0]["tuf"];
}

export function createUpdater(ctx: Pick<CommandContext, "stateDir" | "now">, host: UpdateHost, hooks: UpdateHooks = {}): Updater {
  return new Updater({ stateDir: ctx.stateDir, host, now: ctx.now, tuf: hooks.tuf ?? new TufClient({ stateDir: ctx.stateDir }) });
}

function report(result: UpdateResult, ctx: CommandContext): number {
  if (result.ok) {
    ctx.out(result.message);
    return 0;
  }
  ctx.err(`fx-runner: ${result.message}`);
  return 1;
}

export async function updateCommand(flags: Flags, ctx: CommandContext, host: UpdateHost, hooks: UpdateHooks = {}): Promise<number> {
  const chosen = ["check", "pin", "unpin", "rollback"].filter((name) => flags.has(name));
  if (chosen.length !== 1) throw new CliError("usage: fx-runner update --check | --pin <version> | --unpin | --rollback", 2);
  const updater = createUpdater(ctx, host, hooks);
  const action = chosen[0];
  if (action === "unpin") return report(updater.unpin(), ctx);
  if (action === "pin") {
    const version = flags.get("pin");
    if (typeof version !== "string") throw new CliError("--pin needs a version, for example --pin 1.2.3", 2);
    return report(await updater.pin(version), ctx);
  }
  if (action === "rollback") return report(await updater.rollback(), ctx);

  ctx.out(`Current version: ${updater.current()}`);
  const checked = await updater.check();
  if (!checked.ok) {
    if (checked.state === "refused") {
      ctx.err(`fx-runner: ${checked.message}`);
      return 1;
    }
    ctx.out(checked.state === "paused" ? checked.message[0]!.toUpperCase() + checked.message.slice(1) : `${NOT_CONFIGURED_TEXT[0]!.toUpperCase()}${NOT_CONFIGURED_TEXT.slice(1)}.`);
    return 0;
  }
  const newer = checked.available !== undefined && compareVersions(checked.available, checked.current) > 0;
  ctx.out(`Available version: ${checked.available ?? "none listed for this platform"}`);
  if (updater.kind() === "homebrew") ctx.out(newer ? BREW_LINE : "fx-runner is up to date.");
  else if (newer) ctx.out(`A newer version is available. The runner installs it between jobs; to install it now: fx-runner update --pin ${checked.available}, then fx-runner update --unpin.`);
  else ctx.out("fx-runner is up to date.");
  return 0;
}

export function configCommand(positionals: readonly string[], ctx: CommandContext, host: UpdateHost): number {
  const [verb, key, value] = positionals;
  if (verb !== "set" || key === undefined || value === undefined) throw new CliError("usage: fx-runner config set auto-update on|off", 2);
  if (key !== "auto-update") throw new CliError(`unknown setting ${key.slice(0, 40)}; the only setting is auto-update`, 2);
  if (value !== "on" && value !== "off") throw new CliError("auto-update takes on or off", 2);
  return report(createUpdater(ctx, host).setAutoUpdate(value === "on"), ctx);
}

/** The doctor line for the updater. Reads the state file; makes no network call. */
export function updatesLine(stateDir: string, host: { version?: string | undefined; execPath?: string | undefined } | undefined, configured: boolean = tufConfigured()): { level: "PASS" | "WARN" | "INFO"; detail: string } {
  const version = host?.version;
  const head = version === undefined ? "" : `${version}; `;
  if (host?.execPath !== undefined && isHomebrewPath(host.execPath)) return { level: "INFO", detail: `${head}installed by Homebrew: update with brew upgrade fx-runner; automatic updates are off` };
  if (!configured) return { level: "INFO", detail: `${head}${NOT_CONFIGURED_TEXT}; the runner does not update itself` };
  const state = loadUpdateState(stateDir);
  if (state.damaged === true) return { level: "WARN", detail: `${head}update.json is damaged; automatic updates are off until it is fixed or removed` };
  const parts = [state.pinned === undefined ? "not pinned" : `pinned to ${state.pinned}`, `automatic updates ${state.autoUpdate ? "on" : "off"}`, state.lastCheck === undefined ? "never checked" : `last checked ${state.lastCheck.slice(0, 10)}`];
  if (state.paused !== undefined) parts.push(`updates paused: ${state.paused}`);
  else if (state.checkFailed !== undefined) parts.push(`update check failed: ${state.checkFailed}`);
  return { level: state.paused === undefined && state.checkFailed === undefined ? "PASS" : "WARN", detail: `${head}${parts.join(", ")}` };
}
