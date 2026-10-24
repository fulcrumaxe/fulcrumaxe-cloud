/**
 * D#6 RESUME-CLEAN-MAC: the resumed-workspace purge on macOS, run in a child under `sandbox-exec` with a profile that allows writes only below the
 * workspace's real root (the runner's own `seatbeltProfile` builder, given one write path and nothing else: every other write, the network included,
 * is denied; reads stay open so the child can start and look). The child is this program again (`__purge`, `commands/purgeChild.ts`). It is given the
 * list git produced in the parent through a file in the runner's state directory, re-does the lstat / no-link / exact-realpath checks, and deletes. If a
 * leftover process of the previous run swapped a directory for a link to somewhere else in the meantime, the kernel refuses the unlink there.
 *
 * Fail closed: no `sandbox-exec`, a list that cannot be written, a child that does not exit 0 or whose answer is not two counts: nothing is
 * reported as removed (`undefined`) and the caller logs one count-free line. A child that never started with the profile deleted nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitCapture } from "./git.js";
import type { CleanCounts } from "./resumePurge.js";
import type { SandboxedPurge } from "./resumeClean.js";
import { quoted, seatbeltProfile } from "../sandbox/probe.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PURGE_TIMEOUT_MS = 5 * 60_000;

/** The profile the child runs under: writes below `realRoot` and nowhere else. */
export function purgeProfile(realRoot: string): string {
  if (!path.isAbsolute(realRoot) || realRoot !== path.normalize(realRoot) || realRoot.endsWith(path.sep)) throw new TypeError("purgeProfile: the workspace root must be a normalised absolute path below /");
  // The folders the purge always keeps are write-protected too (the last matching rule wins), so a link swapped in toward them inside the workspace gets nowhere.
  return seatbeltProfile({ filesystem: { allowWrite: [realRoot] } }) + `(deny file-write* (subpath ${quoted(path.join(realRoot, ".git"))}) (subpath ${quoted(path.join(realRoot, ".claude"))}))`;
}

/** The child's whole environment: it finds its state directory through FX_RUNNER_HOME (as `bin/fx-runner.mjs` reads it) and needs nothing else, HOME included. */
export function purgeChildEnv(stateDir: string): Record<string, string> {
  return { LC_ALL: "C", FX_RUNNER_HOME: stateDir };
}

export interface SandboxedPurgeDeps {
  /** The bounded, shell-less capture the runner starts programs through. */
  capture: GitCapture;
  /** This program's own command (`host.selfCommand`): the child is `<selfCommand> __purge <list file> <root>`. */
  selfCommand: readonly string[];
  /** The runner's state directory: the list file lives in a fresh directory under it, removed afterwards. */
  stateDir: string;
  isFile: (target: string) => boolean;
}

/** The answer the child prints: two counts. Anything else is no answer. */
export function parseCounts(stdout: string): CleanCounts | undefined {
  const match = stdout.match(/^(\d{1,9}) (\d{1,9})\n?$/);
  return match === null ? undefined : { files: Number(match[1]), dirs: Number(match[2]) };
}

export function createSandboxedPurge(deps: SandboxedPurgeDeps): SandboxedPurge {
  return async (realRoot, entries) => {
    if (deps.selfCommand.length === 0 || !deps.isFile(SANDBOX_EXEC)) return undefined;
    let dir: string | undefined;
    try {
      const base = path.join(deps.stateDir, "purge");
      mkdirSync(base, { recursive: true, mode: 0o700 });
      dir = mkdtempSync(path.join(base, "p-"));
      const list = path.join(dir, "list");
      writeFileSync(list, entries.join("\0"), { flag: "wx", mode: 0o600 });
      const out = await deps.capture(SANDBOX_EXEC, ["-p", purgeProfile(realRoot), ...deps.selfCommand, "__purge", list, realRoot], purgeChildEnv(deps.stateDir), PURGE_TIMEOUT_MS);
      return out.code === 0 && !out.timedOut ? parseCounts(out.stdout) : undefined;
    } catch {
      // fx-swallow-ok: fail closed; the caller reports that the clean-up did not complete and the workspace stays as kept
      return undefined;
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  };
}
