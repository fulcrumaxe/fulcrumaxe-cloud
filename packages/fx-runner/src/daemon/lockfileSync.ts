/**
 * D#6 BUILD-LOCKFILE-ON-DEP-ADD: the runner brings `pnpm-lock.yaml` up to date after the agent's turn and before the job's check, when the change touched a
 * package manifest.
 *
 * Why the runner and not the agent: the agent's shell sandbox makes every lockfile a protected, empty stub (`sandboxStubs.ts`), so the agent can neither read nor
 * write it, and the brief tells it never to update it. A change that adds a dependency (a `workspace:*` link to another package, say) therefore left the lockfile
 * behind, and the check's frozen install (which must stay frozen) failed at once with `ERR_PNPM_OUTDATED_LOCKFILE`. A fix round could not recover, for the same reason.
 *
 * What runs: `pnpm install --lockfile-only --offline --ignore-scripts --ignore-pnpmfile`, in the workspace, only when `git` reports a changed `package.json` or
 * `pnpm-workspace.yaml` against the job's start commit and the workspace already has a real `pnpm-lock.yaml`. `--lockfile-only` writes nothing but the lockfile (no
 * `node_modules`, no fetch of tarballs); `--offline` means it needs no network: a dependency on another workspace package, a removed dependency or a changed range that
 * the lockfile already satisfies all resolve from the lockfile itself. A new dependency from the registry cannot be resolved offline and ends as the closed failure
 * `needs_network`, at once, and the lockfile is put back; the check then fails as before, and the step line names the code.
 *
 * Threat model (same as `depsInstall.ts`: the repository, and now the agent's edits to it, are hostile; the runner user's rights are real):
 *  - no repo code runs: no lifecycle script, no pnpmfile, no corepack download; the settings files and the lockfile are judged by the same pre-checks as the install
 *    (`settingsRefusal`, `checkPnpmLock`) before pnpm starts, and the lockfile pnpm wrote is judged again before it is kept (other-host tarball, git or link
 *    dependency, missing integrity): a refusal puts the original bytes back;
 *  - the environment is the install's clean allowlist with `HOME`, caches and the store inside a scratch directory made for this run and removed afterwards;
 *  - no link may stand where pnpm looks for projects: pnpm finds them from the workspace globs, not from the lockfile, so before it starts the workspace is walked and a
 *    link to a directory that holds a `package.json`, or any link that is itself named `package.json`, `pnpm-workspace.yaml` or `.npmrc` (even inside an ignored directory
 *    that git never lists), refuses the run (CWE-59). Every changed manifest and every project the lockfile lists must be a plain path too, and
 *    before the new lockfile is kept every importer and every `link:` target in it is judged the same way, and every importer's `package.json` must be a regular file (looked at without following a link);
 *  - the lockfile format must not change (`lockfileVersion`): a different pnpm that would rewrite the whole file is refused, not published;
 *  - a time limit ends the whole process group; the output kept is a capped, redacted tail, and the closed code is all the caller records.
 * The frozen install in the check is not touched or weakened: it still runs frozen, offline, and now finds a lockfile that matches the manifests.
 */
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import { redactShapes } from "@fulcrumaxe/runner-protocol";
import { MAX_LOCKFILE_BYTES, projectIsPlain, readRootFile, registryUrlOf, settingsRefusal, TAIL_SHOWN_CHARS, type DepsRefusal } from "./depsInstall.js";
import type { InstallCapture } from "./engineKit.js";
import { findTool } from "./nixShell.js";
import { installEnv, type CleanEnvOptions } from "../job/cleanEnv.js";
import { checkPnpmLock } from "../job/lockfileCheck.js";

/** pnpm resolving offline from the lockfile is fast; this bounds a stuck process, not a normal run. */
export const LOCK_SYNC_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_KEPT_CHARS = 4096;
/** The pinned host the lockfile's tarballs must come from when the job names none. */
const DEFAULT_REGISTRY_HOST = "registry.npmjs.org";
/** What pnpm (offline) or a connection prints when the resolution needed the network. */
const NETWORK_NEEDED = /ERR_PNPM_NO_OFFLINE|ENETUNREACH|EADDRNOTAVAIL|EAI_AGAIN|ENOTFOUND|ECONNREFUSED/;
/** Files whose change can change what the lockfile must say. */
/** The most entries the walk for linked projects looks at before it gives up (and refuses). */
const MAX_WALK_ENTRIES = 200_000;
const TRIGGER_NAMES: ReadonlySet<string> = new Set(["package.json", "package.yaml", "package.json5", "pnpm-workspace.yaml"]);

export type LockSyncFailure = "tool_missing" | "needs_network" | "exit" | "timeout" | "aborted";

/** The closed result. Only `updated` changes a file; every other answer leaves `pnpm-lock.yaml` as it was. */
export type LockSyncOutcome =
  | { kind: "none" }
  | { kind: "unchanged" }
  | { kind: "updated" }
  | { kind: "failed"; why: LockSyncFailure }
  | { kind: "refused"; reason: DepsRefusal };

export interface LockfileSync {
  run(input: { workspace: string; base: string; registryHost?: string | undefined; signal?: AbortSignal | undefined }): Promise<LockSyncOutcome>;
}

export interface LockfileSyncDeps {
  capture: InstallCapture;
  envOptions: CleanEnvOptions;
  /** The paths the workspace changes against `base` (tracked changes and new files), or null when git could not say (`createChangedFiles`). */
  changedFiles: (workspace: string, base: string) => Promise<string[] | null>;
  /** One line for the runner's terminal: fixed words and a closed code, plus a redacted tail on a failure. */
  say: (line: string) => void;
  timeoutMs?: number;
  /** Where each run's throwaway scratch directory is made (the daemon passes a directory under its own state directory; made here when missing). Never taken from a job. */
  scratchRoot: string;
}

/** The pnpm command line. Registry, store and cache are set here, where they outrank any repo setting. */
export function lockSyncArgs(input: { registry: string; storeDir: string; cacheDir: string }): string[] {
  return [
    "install", "--lockfile-only", "--offline", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", `--registry=${input.registry}`,
    "--config.manage-package-manager-versions=false", "--config.confirm-modules-purge=false", `--config.store-dir=${input.storeDir}`, `--config.cache-dir=${input.cacheDir}`, "--reporter=append-only",
  ];
}

/** The changed paths that can change the lockfile, or "unsafe" when one of them runs through a link. */
function manifestsOf(workspace: string, changed: readonly string[]): string[] | "unsafe" {
  const out: string[] = [];
  for (const rel of changed) {
    const parts = rel.split("/");
    if (!TRIGGER_NAMES.has(parts[parts.length - 1] ?? "") || parts.includes("node_modules") || parts.includes(".git")) continue;
    if (!projectIsPlain(workspace, parts.slice(0, -1).join("/"))) return "unsafe";
    try {
      if (!lstatSync(path.join(workspace, rel)).isFile()) return "unsafe";
    } catch {
      // fx-swallow-ok: a manifest the change deleted is still a change; there is nothing to look at
    }
    out.push(rel);
  }
  return out;
}

/** Names that pnpm reads below the root and that must never be a link, wherever they sit. */
const NEVER_LINKS: ReadonlySet<string> = new Set(["package.json", "package.yaml", "package.json5", "pnpm-workspace.yaml", ".npmrc"]);
/** Other manifest formats pnpm reads. This repository and the product use `package.json` only, so a project directory holding one at all is refused, link or not. */
const OTHER_MANIFESTS: ReadonlySet<string> = new Set(["package.yaml", "package.json5"]);

/** True when a directory below `root` is a link to a directory that holds a `package.json` (pnpm could take it for a project), when a file pnpm reads is a link (`NEVER_LINKS`), or the walk is too big to judge. `node_modules` and `.git` are not entered. */
function hasLinkedProject(root: string): boolean {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // fx-swallow-ok: a directory that cannot be listed cannot be judged; it counts as unsafe
      return true;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return true;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (OTHER_MANIFESTS.has(entry.name)) return true;
      if (entry.isSymbolicLink()) {
        if (NEVER_LINKS.has(entry.name)) return true;
        try {
          if (statSync(full).isDirectory() && statSync(path.join(full, "package.json")).isFile()) return true;
        } catch {
          // fx-swallow-ok: a link that leads nowhere, or to a directory without a manifest, is not a project
        }
      } else if (entry.isDirectory()) stack.push(full);
    }
  }
  return false;
}

/** `lockfileVersion` and the project directories a pnpm lockfile names (every importer, every `link:` target, relative to the workspace), or null when it cannot be read that way. */
function lockFacts(text: string): { version: string; projects: string[]; importers: string[] } | null {
  let lock: unknown;
  try {
    lock = load(text, { schema: JSON_SCHEMA });
  } catch {
    // fx-swallow-ok: text that is not YAML has no facts; the caller refuses
    return null;
  }
  if (typeof lock !== "object" || lock === null || Array.isArray(lock)) return null;
  const top = lock as { lockfileVersion?: unknown; importers?: unknown };
  const projects = new Set<string>();
  const importerDirs: string[] = [];
  const importers = top.importers;
  if (typeof importers === "object" && importers !== null) {
    for (const [dir, entry] of Object.entries(importers as Record<string, unknown>)) {
      projects.add(dir);
      importerDirs.push(dir);
      if (typeof entry !== "object" || entry === null) continue;
      for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const deps = (entry as Record<string, unknown>)[group];
        if (typeof deps !== "object" || deps === null) continue;
        for (const dep of Object.values(deps as Record<string, unknown>)) {
          const version = typeof dep === "object" && dep !== null ? (dep as { version?: unknown }).version : undefined;
          if (typeof version === "string" && version.startsWith("link:")) projects.add(path.posix.normalize(path.posix.join(dir, version.slice("link:".length))));
        }
      }
    }
  }
  return { version: String(top.lockfileVersion), projects: [...projects], importers: importerDirs };
}

/** True when the importer's `package.json` is there as a regular file, looked at without following a link. */
function manifestIsRegular(workspace: string, importer: string): boolean {
  try {
    if (!lstatSync(path.join(workspace, importer, "package.json")).isFile()) return false;
  } catch {
    // fx-swallow-ok: a manifest that cannot be looked at is not a regular file
    return false;
  }
  for (const other of OTHER_MANIFESTS) {
    try {
      if (!lstatSync(path.join(workspace, importer, other)).isFile()) return false;
    } catch {
      // fx-swallow-ok: no such manifest is the normal case
    }
  }
  return true;
}

/** A project directory name that stays inside the workspace and runs through no link. */
function projectIsInside(workspace: string, project: string): boolean {
  if (project === "" || path.posix.isAbsolute(project) || project === ".." || project.startsWith("../")) return false;
  return projectIsPlain(workspace, project);
}

/** Puts `bytes` back as the lockfile: a temp file made without following a link, then renamed over it. False when that failed. */
function putBack(file: string, bytes: Buffer, mode: number): boolean {
  const temp = `${file}.fx-tmp`;
  try {
    rmSync(temp, { force: true });
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    return true;
  } catch {
    // fx-swallow-ok: reported by the caller on the step line ("lockfile not restored")
    rmSync(temp, { force: true });
    return false;
  }
}

export function createLockfileSync(deps: LockfileSyncDeps): LockfileSync {
  const timeoutMs = deps.timeoutMs ?? LOCK_SYNC_TIMEOUT_MS;
  const refuse = (reason: DepsRefusal): LockSyncOutcome => {
    deps.say(`fx-runner: lockfile update refused (lockfile_sync_refused: ${reason})`);
    return { kind: "refused", reason };
  };
  return {
    async run({ workspace, base, registryHost, signal }) {
      const host = registryHost ?? DEFAULT_REGISTRY_HOST;
      const registry = registryUrlOf(host);
      const lockPath = path.join(workspace, "pnpm-lock.yaml");
      const before = readRootFile(workspace, "pnpm-lock.yaml", MAX_LOCKFILE_BYTES);
      if (before.kind === "absent") return { kind: "none" };
      if (before.kind === "refused") return refuse(before.reason);

      const changed = await deps.changedFiles(workspace, base).catch(() => null);
      if (changed === null) {
        deps.say("fx-runner: lockfile update skipped (lockfile_sync_unknown_changes)");
        return { kind: "none" };
      }
      const manifests = manifestsOf(workspace, changed);
      if (manifests === "unsafe") return refuse("workspace_unsafe");
      if (manifests.length === 0) return { kind: "none" };

      const lock = checkPnpmLock(before.text, host);
      if (!lock.ok) return refuse(lock.reason);
      const unsafe = settingsRefusal(workspace, registry);
      if (unsafe !== undefined) return refuse(unsafe);
      if (!lock.projects.every((project) => projectIsPlain(workspace, project))) return refuse("workspace_unsafe");
      // pnpm finds projects from the workspace globs, which the lockfile does not list yet: a link the change added is caught here, before pnpm can read behind it.
      if (hasLinkedProject(workspace)) return refuse("workspace_unsafe");
      if (signal?.aborted === true) return { kind: "failed", why: "aborted" };
      const factsBefore = lockFacts(before.text);

      let originalMode: number;
      try {
        originalMode = lstatSync(lockPath).mode & 0o777;
      } catch {
        // fx-swallow-ok: a lockfile that cannot be looked at again is the closed answer "workspace_unsafe"
        return refuse("workspace_unsafe");
      }
      const original = Buffer.from(before.text, "utf8");

      let scratch: string;
      try {
        mkdirSync(deps.scratchRoot, { recursive: true, mode: 0o700 });
        scratch = mkdtempSync(path.join(deps.scratchRoot, "fx-locksync-"));
        for (const dir of ["home", "tmp", "xdg-cache", "xdg-config", "xdg-data", "xdg-state", "corepack", "store", "cache"]) mkdirSync(path.join(scratch, dir), { mode: 0o700 });
        writeFileSync(path.join(scratch, "empty.npmrc"), "", { flag: "wx", mode: 0o600 });
      } catch {
        // fx-swallow-ok: scratch that cannot be made is the closed answer "workspace_unsafe"
        return refuse("workspace_unsafe");
      }
      const clearScratch = (): void => rmSync(scratch, { recursive: true, force: true });
      const empty = path.join(scratch, "empty.npmrc");
      const env = installEnv(deps.envOptions, {
        HOME: path.join(scratch, "home"),
        TMPDIR: path.join(scratch, "tmp"),
        XDG_CACHE_HOME: path.join(scratch, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(scratch, "xdg-config"),
        XDG_DATA_HOME: path.join(scratch, "xdg-data"),
        XDG_STATE_HOME: path.join(scratch, "xdg-state"),
        COREPACK_HOME: path.join(scratch, "corepack"),
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_STRICT: "0",
        COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "0",
        COREPACK_ENABLE_AUTO_PIN: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        pnpm_config_store_dir: path.join(scratch, "store"),
        npm_config_userconfig: empty,
        npm_config_globalconfig: empty,
        npm_config_registry: registry,
        npm_config_ignore_scripts: "true",
        npm_config_update_notifier: "false",
        npm_config_manage_package_manager_versions: "false",
      });
      const binary = findTool("pnpm", env.PATH ?? "");
      if (binary === undefined) {
        clearScratch();
        deps.say("fx-runner: lockfile update did not run (lockfile_sync_failed: pnpm not found)");
        return { kind: "failed", why: "tool_missing" };
      }
      // A corepack shim would let the repo's `packageManager` field pick the pnpm that runs.
      let real = binary;
      try {
        real = realpathSync(binary);
      } catch {
        // fx-swallow-ok: a binary that cannot be resolved is run as found; the start itself then fails closed
      }
      if (/(^|\/)corepack(\/|$)/.test(real)) {
        clearScratch();
        return refuse("corepack_shim");
      }

      const restore = (): boolean => {
        const now = readRootFile(workspace, "pnpm-lock.yaml", MAX_LOCKFILE_BYTES);
        if (now.kind === "text" && now.text === before.text) return true;
        return putBack(lockPath, original, originalMode);
      };
      let out: Awaited<ReturnType<InstallCapture>>;
      try {
        out = await deps.capture(binary, lockSyncArgs({ registry, storeDir: path.join(scratch, "store"), cacheDir: path.join(scratch, "cache") }), env, workspace, timeoutMs, OUTPUT_KEPT_CHARS, signal, undefined);
      } catch {
        // fx-swallow-ok: a capture that threw did not finish; the lockfile is put back and the closed code says it failed (the error text could hold a path)
        clearScratch();
        const restored = restore();
        deps.say(`fx-runner: lockfile update failed (lockfile_sync_failed: exit${restored ? "" : ", lockfile not restored"})`);
        return { kind: "failed", why: "exit" };
      }
      clearScratch();
      if (out.code !== 0 || out.timedOut || out.aborted) {
        const why: LockSyncFailure = out.aborted ? "aborted" : out.timedOut ? "timeout" : NETWORK_NEEDED.test(out.tail) ? "needs_network" : "exit";
        const restored = restore();
        const shown = redactShapes(out.tail).split(workspace).join("<workspace>").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(-TAIL_SHOWN_CHARS);
        deps.say(`fx-runner: lockfile update failed (lockfile_sync_failed: ${why}${out.code === null ? "" : `, exit ${String(out.code)}`}${restored ? "" : ", lockfile not restored"})${shown === "" ? "" : `: ${shown}`}`);
        return { kind: "failed", why };
      }

      const after = readRootFile(workspace, "pnpm-lock.yaml", MAX_LOCKFILE_BYTES);
      if (after.kind !== "text") {
        restore();
        return refuse("lockfile_not_regular");
      }
      if (after.text === before.text) return { kind: "unchanged" };
      const verdict = checkPnpmLock(after.text, host);
      if (!verdict.ok) {
        restore();
        return refuse(verdict.reason);
      }
      // The new lockfile may name a project pnpm reached through a link, or a `link:` target that is one: judge every one of them as plain paths inside the workspace.
      const factsAfter = lockFacts(after.text);
      if (factsAfter === null || factsBefore === null || !factsAfter.projects.every((project) => projectIsInside(workspace, project)) || !factsAfter.importers.every((importer) => manifestIsRegular(workspace, importer))) {
        restore();
        return refuse("workspace_unsafe");
      }
      if (factsAfter.version !== factsBefore.version) {
        restore();
        return refuse("lockfile_version_changed");
      }
      try {
        chmodSync(lockPath, originalMode);
      } catch {
        // fx-swallow-ok: a mode that cannot be set is not a reason to drop the update
      }
      deps.say("fx-runner: lockfile updated to match the changed manifests (lockfile_sync_updated)");
      return { kind: "updated" };
    },
  };
}
