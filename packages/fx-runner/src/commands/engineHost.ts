/**
 * `fx-runner engine-host stop`: ends the engine host on this machine through the same kill path a cloud halt uses, with no cloud call. It writes
 * `engine-halt.json` first (so the engine's hooks refuse while it runs), kills the host's process group and, on Linux, its systemd user scope, and prints
 * what it could prove. It does not tell the cloud and does not restart anything.
 */
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import { resumeEngineHostLocally, stopEngineHostLocally, type HaltDeps } from "../engineBridge/halt.js";
import { engineStateDir, EngineStateError } from "../engineBridge/stateFiles.js";

export interface EngineHostOptions {
  /** `AUTONOMOUS_TEAM_STATE_DIR`, looked up by name by the caller. */
  engineStateDirOverride?: string | undefined;
  home: string | undefined;
  deps: HaltDeps | undefined;
}

export async function engineHostCommand(positionals: readonly string[], ctx: CommandContext, options: EngineHostOptions): Promise<number> {
  if ((positionals[0] !== "stop" && positionals[0] !== "resume") || positionals.length !== 1) throw new CliError("usage: fx-runner engine-host stop | resume", 2);
  if (options.deps === undefined) throw new CliError("engine-host is only available from the fx-runner program");
  if (options.home === undefined) throw new CliError("cannot find the home directory");
  let dir: string;
  try {
    dir = engineStateDir({ AUTONOMOUS_TEAM_STATE_DIR: options.engineStateDirOverride }, options.home);
    if (positionals[0] === "resume") {
      const result = resumeEngineHostLocally(dir, options.deps);
      ctx.out(
        result === "resumed"
          ? "The local stop is lifted. Nothing was started; start the engine host again yourself."
          : result === "cloud_halt"
            ? "The halt was set from the workspace, so only the workspace can clear it."
            : "The engine is not stopped on this machine.",
      );
      return result === "cloud_halt" ? 1 : 0;
    }
    const { applied, noHostRecorded, haltFileError } = await stopEngineHostLocally(dir, options.deps);
    if (haltFileError !== undefined) ctx.err(`The halt file could not be written (${haltFileError}). The kill path ran anyway; the engine's hooks may not refuse until that is fixed.`);
    for (const line of noHostRecorded ? [] : (applied.refused ?? [])) ctx.err(`Not checked: ${line}.`);
    if (noHostRecorded && applied.method === "none") {
      ctx.out("No engine host is recorded on this machine, so no process was checked. The halt file is written, so the engine's hooks refuse until it is cleared.");
    } else if (applied.method === "none") ctx.out("Engine host stop was attempted, but nothing could be checked, so its tree is counted as still running.");
    else if (applied.survivors === 0 && applied.method === "scope") ctx.out("Engine host stopped. No process of its tree is left (checked in its systemd scope).");
    else if (applied.survivors === 0) ctx.out("Engine host stopped. Its process group is empty; detached processes not verified on this machine.");
    else ctx.out(`Engine host stopped, but ${applied.survivors} process(es) of its tree are still alive (${applied.method === "scope" ? "counted in its systemd scope" : "counted in its process group"}).`);
    if (haltFileError !== undefined) return 1;
    // A machine with no host recorded has nothing to count against: the halt file is the brake, and the message above says nothing was checked.
    if (noHostRecorded && applied.method === "none") return 0;
    return applied.survivors === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof EngineStateError) throw new CliError(error.message);
    throw error;
  }
}
