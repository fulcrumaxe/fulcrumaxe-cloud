/**
 * The tmux calls of the watch (D#6 R4a-7). tmux is run through the bounded capture the daemon already has (no shell, an explicit
 * environment); nothing here starts a process itself. The tmux server runs as this user on a socket in a private directory under the
 * state directory, with an environment of five names (`tmuxEnv`): no credential is ever in a tmux environment, argument or pane command.
 * The agent is never started by tmux: a pane only renders the job's transcript (`__watch`), and after a take-over runs `__takeover`.
 */
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { GitCapture } from "../daemon/git.js";
import { ensurePrivateDir, sessionName, shortId, socketPath, tmuxDir } from "./layout.js";

const TIMEOUT_MS = 10_000;
/** The only names the tmux server and its panes start with. */
export function tmuxEnv(input: { home: string; path: string; stateDir: string; term?: string | undefined }): Record<string, string> {
  // FX_RUNNER_HOME hands the panes the daemon's own state directory: a path, not a credential. Without it a pane under a state-directory override would look in ~/.fx-runner.
  return { HOME: input.home, FX_RUNNER_HOME: input.stateDir, PATH: input.path, LANG: "C.UTF-8", TERM: input.term !== undefined && /^[A-Za-z0-9._+-]{1,40}$/.test(input.term) ? input.term : "xterm-256color" };
}

/** The longest socket path a Unix socket can take (sun_path is 104 bytes on macOS, 108 on Linux, with the terminating NUL). */
export const MAX_SOCKET_PATH_BYTES = 100;

/** The tmux binary on `searchPath`, as an absolute path, or undefined. */
export function findTmux(searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "tmux");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // fx-swallow-ok: not executable here; the next directory may hold it
    }
  }
  return undefined;
}

export interface TmuxConfig {
  binary: string;
  stateDir: string;
  capture: GitCapture;
  env: Record<string, string>;
  /** How this program is started again for a pane: the runtime, its own flags and the script (`__watch <run>` is appended). */
  selfCommand: readonly string[];
}

/** What a watch pane shows in tmux's status line. */
export function statusLine(role: string, repo: string, runId: string): string {
  return `Watching ${role} on ${repo}. Detach: Ctrl-b d. To take over: fx-runner attach ${shortId(runId)} --take-over`;
}

const withSocket = (cfg: Pick<TmuxConfig, "stateDir">, args: readonly string[]): string[] => ["-S", socketPath(cfg.stateDir), ...args];

async function tmux(cfg: TmuxConfig, args: readonly string[]): Promise<boolean> {
  const result = await cfg.capture(cfg.binary, withSocket(cfg, args), cfg.env, TIMEOUT_MS);
  return result.code === 0 && !result.timedOut;
}

/** One session, `fx-<short id>`, whose single pane runs `fx-runner __watch <run>`. False when tmux would not start it: the job runs without a watch. */
export async function startWatch(cfg: TmuxConfig, entry: { runId: string; role: string; repo: string }): Promise<boolean> {
  ensurePrivateDir(tmuxDir(cfg.stateDir));
  const name = sessionName(entry.runId);
  if (!(await tmux(cfg, ["new-session", "-d", "-s", name, "-x", "200", "-y", "50", ...cfg.selfCommand, "__watch", entry.runId]))) return false;
  await tmux(cfg, ["set-option", "-t", name, "status-left-length", "200"]);
  await tmux(cfg, ["set-option", "-t", name, "status-left", statusLine(entry.role, entry.repo, entry.runId).replaceAll("#", "##")]);
  return true;
}

export const hasSession = (cfg: TmuxConfig, runId: string): Promise<boolean> => tmux(cfg, ["has-session", "-t", `=${sessionName(runId)}`]);

/** Replaces the pane's command with `fx-runner __takeover <run>`. The old command is killed. */
export const swapToTakeover = (cfg: TmuxConfig, runId: string): Promise<boolean> => tmux(cfg, ["respawn-pane", "-k", "-t", sessionName(runId), ...cfg.selfCommand, "__takeover", runId]);

export const endWatch = (cfg: TmuxConfig, runId: string): Promise<boolean> => tmux(cfg, ["kill-session", "-t", `=${sessionName(runId)}`]);

/** The arguments of the tmux client for `attach`: read-only (`-r`) unless the person is taking over. */
export function attachArgs(stateDir: string, runId: string, readOnly: boolean): string[] {
  return withSocket({ stateDir }, ["attach-session", ...(readOnly ? ["-r"] : []), "-t", `=${sessionName(runId)}`]);
}
