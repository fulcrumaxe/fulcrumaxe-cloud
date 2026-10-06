/**
 * Model-call guard: the logic behind the vitest setup file in `./setup.ts`.
 *
 * Kept separate from `setup.ts` (which just calls `installModelCallGuard()`
 * at import time) so the fixture test can call the installer directly and
 * assert on its behaviour.
 */
import { createRequire } from "node:module";
import { basename } from "node:path";

// `import * as childProcess from "node:child_process"` gives back a frozen
// ESM namespace object under Node's CJS interop -- its properties cannot be
// reassigned ("Cannot redefine property: spawn"). Go through `require` to
// get the real, mutable CommonJS exports object instead.
const childProcess: typeof import("node:child_process") =
  createRequire(import.meta.url)("node:child_process");

export const FORBIDDEN_MODEL_HOSTS = [
  "ai-gateway.vercel.sh",
  "api.anthropic.com",
] as const;

export class ModelCallBlockedError extends Error {}

function hostFromFetchInput(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input).host;
    if (input instanceof URL) return input.host;
    if (
      input &&
      typeof input === "object" &&
      "url" in input &&
      typeof (input as { url: unknown }).url === "string"
    ) {
      return new URL((input as { url: string }).url).host;
    }
  } catch {
    return null;
  }
  return null;
}

function mentionsClaudeBinary(command: string, args: unknown): boolean {
  // Match on basenames, not full paths: `command` is frequently an
  // absolute path (spawn's `file`), and argv[0] conventionally repeats
  // that same absolute path as args[0] (confirmed for esbuild's own
  // service spawn). Testing the raw strings let an unrelated binary trip
  // this guard purely because some ancestor directory in its path
  // happened to contain "claude" (e.g. a checkout under
  // `~/.claude/worktrees/...`) -- that false positive blocked `esbuild`
  // itself when it was invoked from a path like that.
  //
  // A path-like argument (anything containing a path separator) is
  // reduced to its basename before testing; a plain word argument (e.g.
  // the `-c "claude -p ..."` shell command line `exec()` builds) is
  // tested as-is, since collapsing it to a "basename" would make no
  // sense and it carries none of the false-positive risk a path does.
  const argsText = Array.isArray(args)
    ? args
        .filter((a): a is string => typeof a === "string")
        .map((a) => (a.includes("/") || a.includes("\\") ? basename(a) : a))
        .join(" ")
    : "";
  return /\bclaude(-code)?\b/i.test(`${basename(command)} ${argsText}`);
}

export interface InstalledGuard {
  /** Restores the original fetch and child_process functions. */
  uninstall: () => void;
}

/**
 * Installs the guard on `globalThis.fetch` and every `node:child_process`
 * spawn/exec variant. No-op (and returns a no-op uninstall) unless
 * `FX_FORBID_MODEL_CALLS=1` is set, so the guard costs nothing in any other
 * environment.
 */
export function installModelCallGuard(
  env: Record<string, string | undefined> = process.env,
): InstalledGuard {
  if (env.FX_FORBID_MODEL_CALLS !== "1") {
    return { uninstall: () => {} };
  }

  const realFetch = globalThis.fetch;
  const guardedFetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const host = hostFromFetchInput(input);
    if (host && (FORBIDDEN_MODEL_HOSTS as readonly string[]).includes(host)) {
      throw new ModelCallBlockedError(
        `test-guard: blocked fetch() to model endpoint "${host}" while FX_FORBID_MODEL_CALLS=1`,
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = guardedFetch;

  // `spawn`/`exec`/`execFile`/`fork` are all thin wrappers that end up
  // calling `ChildProcess.prototype.spawn(options)` internally, using
  // child_process's own internal reference to the `ChildProcess` class --
  // never whatever alias a caller imported it under. Patching the
  // prototype method here intercepts every one of those call styles
  // (`import * as cp`, `import { spawn }`, `require(...)`) uniformly,
  // which a patch on the individual exported functions cannot guarantee:
  // Node's CJS/ESM interop for `node:child_process` snapshots some named
  // exports (e.g. `spawn`) into the ESM namespace rather than exposing a
  // live binding, so mutating `module.exports.spawn` is not reliably
  // observed by `import * as cp from "node:child_process"` call sites
  // (confirmed empirically: patching the exported `spawn` directly is
  // silently ignored by `import * as cp` call sites, while `exec`
  // happened to work -- an unreliable, property-dependent quirk, not
  // something to build a guard on).
  const ChildProcessCtor = childProcess.ChildProcess as unknown as {
    prototype: { spawn: (options: unknown) => unknown };
  };
  const originalProtoSpawn = ChildProcessCtor.prototype.spawn;
  ChildProcessCtor.prototype.spawn = function guardedProtoSpawn(
    this: unknown,
    options: unknown,
  ) {
    const opts = options as { file?: unknown; args?: unknown };
    const file = typeof opts?.file === "string" ? opts.file : "";
    const args = Array.isArray(opts?.args) ? opts.args : undefined;
    if (mentionsClaudeBinary(file, args)) {
      throw new ModelCallBlockedError(
        `test-guard: blocked child_process spawn of ${JSON.stringify(
          file,
        )} while FX_FORBID_MODEL_CALLS=1`,
      );
    }
    return originalProtoSpawn.call(this, options);
  };

  return {
    uninstall: () => {
      globalThis.fetch = realFetch;
      ChildProcessCtor.prototype.spawn = originalProtoSpawn;
    },
  };
}
