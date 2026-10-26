import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LaunchPlace } from "../../launchDir.js";
import { findExecutable } from "../../sandbox/select.js";
import { runCapture, type SpawnFn } from "./capture.js";

/**
 * The CLI's shell sandbox (bubblewrap on Linux) turns every `Edit(...)` deny rule that names a path into a read-only bind, and puts an empty
 * placeholder on each path it protects. A read-only bind over a folder leaves no room to make a placeholder inside it: with CLI 2.1.310 every Bash call
 * then died before its command began ("bwrap: Can't create file <workspace>/.git/config.lock: Read-only file system"), because a deny rule covered the
 * whole `.git` folder. That turned Bash off for every job.
 *
 * `bashSandboxArgs` is the runner's model of that translation, written once: the probe below and the real-bubblewrap test both use it. It reads the
 * job's own settings, so a later rule that breaks the placeholders the same way is caught by the probe on that job and by the test.
 */

/** The placeholder the CLI 2.1.310 puts inside `.git` on every Bash call (seen in the failing run's error): bubblewrap makes the mount point, so `.git` must be writable. */
const GIT_PLACEHOLDERS: readonly string[] = ["config.lock"];
const GLOB = /[*?[\]{}!\\]/;

export interface SettingsWithDeny {
  permissions?: unknown;
}

/** The absolute paths of the `Edit(//abs)` and `Edit(//abs/**)` deny rules in a settings object; a rule with a glob elsewhere is not one path and is left out. */
export function editDeniedPaths(settings: SettingsWithDeny): string[] {
  const permissions = settings.permissions;
  const deny = typeof permissions === "object" && permissions !== null ? (permissions as { deny?: unknown }).deny : undefined;
  const found: string[] = [];
  for (const rule of Array.isArray(deny) ? deny : []) {
    const match = typeof rule === "string" ? rule.match(/^Edit\(\/(\/[^)]*?)(?:\/\*\*)?\)$/) : null;
    if (match?.[1] !== undefined && !GLOB.test(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * The bubblewrap arguments for one Bash call in `root` (a git workspace laid out like `workspace`): the whole filesystem read-only, `root` writable, a
 * read-only bind on each existing path a deny rule names inside the workspace, an empty read-only placeholder for each one that is not there, then the
 * CLI's own placeholders in `.git`.
 */
export function bashSandboxArgs(settings: SettingsWithDeny, workspace: string, root: string): string[] {
  const args = ["--ro-bind", "/", "/", "--bind", root, root, "--dev", "/dev"];
  for (const denied of editDeniedPaths(settings)) {
    const rel = path.relative(workspace, denied);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const target = path.join(root, rel);
    if (existsSync(target)) args.push("--ro-bind", target, target);
    else if (existsSync(path.dirname(target))) args.push("--ro-bind", "/dev/null", target);
  }
  for (const name of GIT_PLACEHOLDERS) {
    const target = path.join(root, ".git", name);
    if (!existsSync(target)) args.push("--ro-bind", "/dev/null", target);
  }
  return args;
}

/** A throwaway git folder shaped like a fresh workspace (hooks, info, config, HEAD), so the probe never makes a placeholder in the real one. */
export function makeProbeWorkspace(parent: string): string {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, "probe-"));
  for (const dir of [".git/hooks", ".git/info", ".git/objects", ".git/refs"]) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  return root;
}

/** Runs one program with no shell and a time limit; the engine passes its own capture, so the probe starts a process the way the engine does. */
export type BashProbeRun = (file: string, args: readonly string[]) => Promise<{ code: number | null; stderr?: string }>;

/**
 * Before the agent starts: run a no-op under the shape the CLI gives a Bash call, in a throwaway copy of the workspace layout. True when bubblewrap
 * refuses it with its own error (every Bash call of the job would fail the same way, so the run should end now and say so). Anything else, including no
 * bubblewrap on this machine (macOS), a probe that could not be set up, or a failure that is not bubblewrap's, is not this check's to judge: false.
 */
export async function bashSandboxUnusable(settings: SettingsWithDeny, workspace: string, env: { PATH?: string }, scratchParent: string, run: BashProbeRun): Promise<boolean> {
  const bwrap = findExecutable("bwrap", env.PATH ?? "");
  if (bwrap === undefined) return false;
  try {
    const root = makeProbeWorkspace(scratchParent);
    const out = await run(bwrap, [...bashSandboxArgs(settings, path.resolve(workspace), root), "--", "true"]);
    return out.code !== 0 && /^bwrap:/m.test(out.stderr ?? "");
  } catch {
    // fx-swallow-ok: a probe that could not be set up says nothing about the sandbox; the agent's own start reports a real failure
    return false;
  } finally {
    rmSync(scratchParent, { recursive: true, force: true });
  }
}

/** The probe as the engine runs it: the process goes through the engine capture (no shell, a time limit, a fresh launch directory), like the version and login questions. */
export function bashSandboxUnusableFor(settings: SettingsWithDeny, workspace: string, scratchParent: string, opts: { env: Record<string, string>; spawn: SpawnFn; launch: LaunchPlace }): Promise<boolean> {
  return bashSandboxUnusable(settings, workspace, opts.env, scratchParent, (file, args) => runCapture(opts.spawn, opts.launch, file, args, opts.env, 15_000, 1024, 2048));
}
