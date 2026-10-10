/**
 * D#6 C44-4 (ruling G-C44-7): the host-side dependency install of a job's workspace, run by the daemon after the clone and before the agent's sandbox starts.
 *
 * Why here: the installed CLI's scrub mode protects `node_modules/.bin` inside its sandbox, so an agent's own install cannot finish. Running a normal install
 * outside the sandbox would run the repo's lifecycle scripts, pnpmfile and `.npmrc` with the runner's own network. So the runner installs, and no repo code runs.
 *
 * Threat model: the repository is hostile and the host install has the runner user's rights and network. This step must not run, load or be steered by
 * anything the repo supplies except data that is checked first:
 *  - `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` or `npm ci --ignore-scripts`: no lifecycle script, pnpmfile or other repo code runs;
 *  - the registry, the store (the job's own per-repo store, shared with its sandbox) and the caches are set on the command line and in the environment, which outrank any repo setting; the user's own npm config is
 *    not read (an empty file stands in for it); the environment is built from scratch (`installEnv`) and carries no model key, git token or connection secret;
 *  - before anything starts, the lockfile (a regular file, non-empty, size-bounded, opened without following a link), `.npmrc` and `pnpm-workspace.yaml` are
 *    checked (`job/lockfileCheck.ts`) and any doubt refuses the install: tarballs only from the pinned registry host with an integrity hash, no git, file, link
 *    out of the repo or other-host dependency, and no setting in `.npmrc` that could move the registry, add auth or enable scripts;
 *  - every `node_modules` in the workspace is removed first (removal follows no link) and a `node_modules` that is a link refuses the install, as does a project
 *    directory that is a link, so the package manager cannot be steered into writing outside the workspace;
 *  - a time limit ends the whole process group; the output kept is a capped, redacted tail.
 * A refusal or a failure never fails the run: the agent is told in one fixed line, and the closed outcome is a stage mark (`deps_installed`, `deps_install_failed`).
 * Known limit: a package that needs its install script (a native build) is not built; the agent's line says so.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactShapes } from "@fulcrumaxe/runner-protocol";
import type { InstallCapture } from "./engineKit.js";
import { findTool } from "./nixShell.js";
import { installEnv, type CleanEnvOptions } from "../job/cleanEnv.js";
import { checkNpmLock, checkNpmrc, checkPnpmLock, checkWorkspaceYaml, type LockRefusal } from "../job/lockfileCheck.js";

/** The time one install may take before its process group is ended (same bound as the cloud's install phase is not shared: a person's machine may be slower). */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** A lockfile over this size is not read and not installed from. The same bound as the cloud's install phase. */
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 256 * 1024;
/** The workspace-state file lists every project, so a large monorepo's is big. */
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const OUTPUT_KEPT_CHARS = 4096;
export const TAIL_SHOWN_CHARS = 500;
/** The most entries the workspace walk looks at before it gives up (and refuses). */
const MAX_WALK_ENTRIES = 200_000;

export type DepsRefusal = LockRefusal | "lockfile_not_regular" | "lockfile_too_big" | "node_modules_link" | "workspace_unsafe" | "corepack_shim";
export type DepsFailure = "tool_missing" | "exit" | "timeout" | "aborted";

/** The closed result. `refused` is the `deps_lockfile_refused` detail; `failed` is `deps_install_failed`; `installed` is `deps_installed`. */
export type DepsOutcome =
  | { kind: "none" }
  | { kind: "installed" }
  | { kind: "failed"; why: DepsFailure }
  | { kind: "refused"; reason: DepsRefusal };

export interface DepsInstaller {
  /**
   * `storeDir` is the job's own package store, the very directory the agent's sandbox is given as `pnpm_config_store_dir`: pnpm records the store in
   * `node_modules`, and a different one in the agent's later `pnpm exec` or `pnpm run` makes it try to purge and reinstall, which the sandbox cannot do.
   */
  run(input: { workspace: string; registryHost: string; storeDir: string; signal?: AbortSignal }): Promise<DepsOutcome>;
}

export interface DepsInstallerDeps {
  capture: InstallCapture;
  /** Where node, npm and pnpm are found, as for the agent's PATH. */
  envOptions: CleanEnvOptions;
  /** One line for the runner's terminal. Fixed words, a closed code and a redacted, capped output tail; never a path from the repo. */
  say: (line: string) => void;
  timeoutMs?: number;
}

type Read = { kind: "absent" } | { kind: "refused"; reason: "lockfile_not_regular" | "lockfile_too_big" } | { kind: "text"; text: string };

/** One file at the workspace root, looked at without following a link and read through an open handle that is judged again: absent, refused, or its text. */
function readRootFile(root: string, name: string, maxBytes: number): Read {
  const file = path.join(root, name);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    // fx-swallow-ok: a file that is not there is the answer "absent"
    return { kind: "absent" };
  }
  if (!stat.isFile()) return { kind: "refused", reason: "lockfile_not_regular" };
  if (stat.size === 0) return { kind: "absent" };
  if (stat.size > maxBytes) return { kind: "refused", reason: "lockfile_too_big" };
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1 || opened.size === 0 || opened.size > maxBytes) return { kind: "refused", reason: opened.size > maxBytes ? "lockfile_too_big" : "lockfile_not_regular" };
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { kind: "text", text: buffer.subarray(0, read).toString("utf8") };
  } catch {
    // fx-swallow-ok: a file that cannot be opened without following a link is refused, never read another way
    return { kind: "refused", reason: "lockfile_not_regular" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Removes every `node_modules` below `root` (a link or a non-directory of that name refuses). Nothing is followed, and `.git` is not entered. */
function clearNodeModules(root: string): DepsRefusal | undefined {
  const found: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // fx-swallow-ok: a directory that cannot be listed is the closed answer "workspace_unsafe"
      return "workspace_unsafe";
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return "workspace_unsafe";
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") {
        if (!entry.isDirectory()) return "node_modules_link";
        found.push(full);
      } else if (entry.isDirectory()) stack.push(full);
    }
  }
  for (const full of found) {
    const rel = path.relative(root, full);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "workspace_unsafe";
    try {
      if (!lstatSync(full).isDirectory()) return "node_modules_link";
      rmSync(full, { recursive: true, force: true });
    } catch {
      // fx-swallow-ok: a tree that cannot be removed is the closed answer "workspace_unsafe"
      return "workspace_unsafe";
    }
  }
  return undefined;
}

/** True when no component of `relative` below `root` is a link or a file (a missing one ends the walk: the package manager would create it as a real directory). */
function projectIsPlain(root: string, relative: string): boolean {
  let current = root;
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      // fx-swallow-ok: not there yet; nothing below it exists either
      return true;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * pnpm records in `node_modules/.pnpm-workspace-state-v1.json` what its install saw, and the agent's later `pnpm exec` or `pnpm run` compares it with what it
 * sees now; a difference makes it run `pnpm install` first, which the agent's sandbox cannot finish (scrub mode protects `node_modules/.bin`). An install made
 * with `--ignore-pnpmfile` leaves out the `pnpmfiles` list that the later run, which does not ignore pnpmfiles, records as `[]` for a repo with none. So the
 * list is added here, empty, to the file the install just wrote in the fresh `node_modules` (a regular file, read and replaced without following a link).
 * Any other shape is left alone: the agent's run then reports the install it could not make.
 */
function recordNoPnpmfiles(modules: string): void {
  const file = path.join(modules, ".pnpm-workspace-state-v1.json");
  const read = readRootFile(modules, ".pnpm-workspace-state-v1.json", MAX_STATE_BYTES);
  if (read.kind !== "text") return;
  try {
    const state = JSON.parse(read.text) as unknown;
    if (typeof state !== "object" || state === null || Array.isArray(state) || "pnpmfiles" in state) return;
    const temp = `${file}.fx-tmp`;
    writeFileSync(temp, JSON.stringify({ ...(state as Record<string, unknown>), pnpmfiles: [] }, null, 2), { flag: "wx", mode: 0o644 });
    renameSync(temp, file);
  } catch {
    // fx-swallow-ok: a state file this step cannot read or replace is left as pnpm wrote it
  }
}

/**
 * The pnpm command line. Every location the repo could move (registry, store, caches, virtual store, modules directory) is set here, where it outranks a
 * `.npmrc` or a `pnpm-workspace.yaml`; the pre-check refuses those files' settings as well, so a miss in one is not a miss in both. The virtual store and the modules
 * directory are the defaults, given as relative paths so each project of a workspace keeps its own `node_modules` below the workspace.
 */
export function pnpmArgs(input: { registry: string; storeDir: string; cacheDir: string }): string[] {
  return [
    "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", `--registry=${input.registry}`, "--config.manage-package-manager-versions=false",
    "--config.confirm-modules-purge=false", "--config.modules-dir=node_modules", "--config.virtual-store-dir=node_modules/.pnpm", `--config.store-dir=${input.storeDir}`,
    `--config.cache-dir=${input.cacheDir}`, "--reporter=append-only",
  ];
}

/** The pinned registry address for a host. */
export const registryUrlOf = (host: string): string => `https://${host}/`;

export function createDepsInstaller(deps: DepsInstallerDeps): DepsInstaller {
  const timeoutMs = deps.timeoutMs ?? INSTALL_TIMEOUT_MS;

  function refuse(reason: DepsRefusal): DepsOutcome {
    deps.say(`fx-runner: dependency install refused (deps_lockfile_refused: ${reason})`);
    return { kind: "refused", reason };
  }

  return {
    async run({ workspace, registryHost, storeDir, signal }) {
      const pnpm = readRootFile(workspace, "pnpm-lock.yaml", MAX_LOCKFILE_BYTES);
      const npm = readRootFile(workspace, "package-lock.json", MAX_LOCKFILE_BYTES);
      for (const read of [pnpm, npm]) if (read.kind === "refused") return refuse(read.reason);
      const manager = pnpm.kind === "text" ? "pnpm" : npm.kind === "text" ? "npm" : undefined;
      if (manager === undefined) return { kind: "none" };
      const registry = registryUrlOf(registryHost);

      const lock = manager === "pnpm" ? checkPnpmLock((pnpm as { text: string }).text, registryHost) : checkNpmLock((npm as { text: string }).text, registryHost);
      if (!lock.ok) return refuse(lock.reason);
      const settings: Array<[Read, (text: string) => ReturnType<typeof checkNpmrc>]> = [
        [readRootFile(workspace, ".npmrc", MAX_SETTINGS_BYTES), (text) => checkNpmrc(text, registry)],
        [readRootFile(workspace, "pnpm-workspace.yaml", MAX_SETTINGS_BYTES), checkWorkspaceYaml],
      ];
      for (const [read, check] of settings) {
        if (read.kind === "refused") return refuse("npmrc_unsafe");
        if (read.kind === "text") {
          const verdict = check(read.text);
          if (!verdict.ok) return refuse(verdict.reason);
        }
      }
      const cleared = clearNodeModules(workspace);
      if (cleared !== undefined) return refuse(cleared);
      if (!lock.projects.every((project) => projectIsPlain(workspace, project))) return refuse("workspace_unsafe");

      // The package manager's scratch lives under the (now fresh) `node_modules`, which version control ignores in practice and the sandbox protects.
      const modules = path.join(workspace, "node_modules");
      const scratch = path.join(modules, ".fx-install");
      const empty = path.join(scratch, "empty.npmrc");
      const pnpmCache = path.join(modules, ".pnpm-cache");
      const npmCache = path.join(modules, ".npm-cache");
      try {
        mkdirSync(modules, { mode: 0o755 });
        // The store is the runner's own per-repo directory (made 0700, as the sandbox does for the same path); the repo cannot place a link there.
        mkdirSync(path.dirname(storeDir), { recursive: true, mode: 0o700 });
        mkdirSync(storeDir, { recursive: true, mode: 0o700 });
        for (const dir of [scratch, path.join(scratch, "home"), path.join(scratch, "tmp"), path.join(scratch, "xdg-cache"), path.join(scratch, "xdg-config"), path.join(scratch, "xdg-data"), path.join(scratch, "xdg-state"), path.join(scratch, "corepack")]) mkdirSync(dir, { mode: 0o700 });
        writeFileSync(empty, "", { flag: "wx", mode: 0o600 });
      } catch {
        // fx-swallow-ok: scratch that cannot be made is the closed answer "workspace_unsafe"
        return refuse("workspace_unsafe");
      }
      const env = installEnv(deps.envOptions, {
        HOME: path.join(scratch, "home"),
        TMPDIR: path.join(scratch, "tmp"),
        XDG_CACHE_HOME: path.join(scratch, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(scratch, "xdg-config"),
        XDG_DATA_HOME: path.join(scratch, "xdg-data"),
        XDG_STATE_HOME: path.join(scratch, "xdg-state"),
        COREPACK_HOME: path.join(scratch, "corepack"),
        // A corepack shim would fetch the pnpm that the repo's `packageManager` names: no network, no strict switch, no custom download address.
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_STRICT: "0",
        COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "0",
        COREPACK_ENABLE_AUTO_PIN: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        pnpm_config_store_dir: storeDir,
        pnpm_config_verify_store_integrity: "true",
        npm_config_userconfig: empty,
        npm_config_globalconfig: empty,
        npm_config_registry: registry,
        npm_config_ignore_scripts: "true",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        npm_config_manage_package_manager_versions: "false",
      });
      const binary = findTool(manager, env.PATH ?? "");
      const clearScratch = (): void => {
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch {
          // fx-swallow-ok: the scratch is under node_modules; a failed removal leaves only empty directories
        }
      };
      if (binary === undefined) {
        clearScratch();
        deps.say(`fx-runner: dependency install did not run (deps_install_failed: ${manager} not found)`);
        return { kind: "failed", why: "tool_missing" };
      }
      // The program must be the real package manager. If it resolves to a corepack shim, the repo's `packageManager` field would choose which pnpm runs.
      let real = binary;
      try {
        real = realpathSync(binary);
      } catch {
        // fx-swallow-ok: a binary that cannot be resolved is run as found; the start itself then fails closed
      }
      if (/(^|\/)corepack(\/|$)/.test(real)) {
        const manifest = readRootFile(workspace, "package.json", MAX_SETTINGS_BYTES * 4);
        let names = false;
        if (manifest.kind === "refused") names = true;
        else if (manifest.kind === "text") {
          try {
            names = typeof (JSON.parse(manifest.text) as { packageManager?: unknown }).packageManager === "string";
          } catch {
            // fx-swallow-ok: a package.json that is not JSON cannot be told apart from one that names a manager, so it counts as naming one
            names = true;
          }
        }
        if (names) {
          clearScratch();
          return refuse("corepack_shim");
        }
      }
      const args = manager === "pnpm" ? pnpmArgs({ registry, storeDir, cacheDir: pnpmCache }) : ["ci", "--ignore-scripts", `--registry=${registry}`, `--cache=${npmCache}`, `--userconfig=${empty}`, `--globalconfig=${empty}`, "--no-fund", "--no-audit", "--no-update-notifier"];
      const out = await deps.capture(binary, args, env, workspace, timeoutMs, OUTPUT_KEPT_CHARS, signal);
      clearScratch();
      if (out.code === 0 && !out.timedOut && !out.aborted) {
        if (manager === "pnpm") recordNoPnpmfiles(modules);
        return { kind: "installed" };
      }
      const why: DepsFailure = out.aborted ? "aborted" : out.timedOut ? "timeout" : "exit";
      const shown = redactShapes(out.tail).split(workspace).join("<workspace>").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(-TAIL_SHOWN_CHARS);
      deps.say(`fx-runner: dependency install failed (deps_install_failed: ${why}${out.code === null ? "" : `, exit ${String(out.code)}`})${shown === "" ? "" : `: ${shown}`}`);
      return { kind: "failed", why };
    },
  };
}
