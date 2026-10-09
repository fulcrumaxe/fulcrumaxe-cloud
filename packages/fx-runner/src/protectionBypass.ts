/**
 * Reaching a cloud that sits behind Vercel Deployment Protection (staging and protected previews only; production needs no bypass).
 * The secret is the project's "Protection Bypass for Automation" value, kept in a file that `FX_RUNNER_PROTECTION_BYPASS_FILE` names.
 * It is sent as the `x-vercel-protection-bypass` header on requests to the registered cloud origin and nowhere else: not to GitHub, not
 * to the git proxy, not to a redirect target. The value is never printed, logged, put in argv or written into the registration.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CliError } from "./cliError.js";
import { cacheRootsFor } from "./daemon/mirror.js";
import { pathsOverlap } from "./sandbox/sandboxSettings.js";

export const BYPASS_ENV_NAME = "FX_RUNNER_PROTECTION_BYPASS_FILE";
export const BYPASS_HEADER = "x-vercel-protection-bypass";
const MAX_SECRET_LENGTH = 256;

/** The closed refusal codes. The text never contains the file's content. */
export type BypassRefusal = "bypass_file_location" | "bypass_file_unreadable" | "bypass_file_not_regular" | "bypass_file_not_owned" | "bypass_file_mode" | "bypass_file_invalid";

export type Bypass = { kind: "unset" } | { kind: "ok"; secret: string } | { kind: "refused"; code: BypassRefusal };

const FIX: Readonly<Record<BypassRefusal, string>> = {
  bypass_file_location: "it must be a file under your home directory (the state directory ~/.fx-runner is the place for it), outside the runner's cache directories",
  bypass_file_unreadable: "the file cannot be opened",
  bypass_file_not_regular: "it must be a plain file, not a link or a directory",
  bypass_file_not_owned: "it must be owned by the user running fx-runner",
  bypass_file_mode: "it must not be readable by others; run: chmod 600 on it",
  bypass_file_invalid: "it must hold one value of printable characters with no spaces, at most 256 long",
};

/** The fixed refusal text for a code. */
export function bypassRefusalText(code: BypassRefusal): string {
  return `${code}: ${BYPASS_ENV_NAME} names a file that cannot be used; ${FIX[code]}`;
}

/**
 * What the location rule needs from the machine. The job's agent runs as the same user, so file mode and owner do not keep the secret
 * from it; only the sandbox's read denial of the home directory does. So the file must really lie under `home`, and not under a
 * directory the sandbox re-allows for reads (the workspaces, the job temp directories and the mirrors: `cacheRootsFor`, the same function
 * the job runner and the sandbox probe use). No `home` means no file is accepted.
 */
export interface BypassPlace {
  home: string | undefined;
  platform: NodeJS.Platform;
  xdgCacheHome?: string | undefined;
  /** Test seam: the real-path function. Default `realpathSync`. */
  realpath?: (value: string) => string;
}

/** Whether `child` is `parent` or under it, by whole path segments. */
function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * True when the open handle's file really lies under the home directory and under no re-allowed read root. The real path of `file` is
 * resolved (every link followed) and its device and inode must equal the handle's, so a swap between the open and this check is caught.
 */
function locationOk(file: string, handle: { dev: number; ino: number }, place: BypassPlace | undefined): boolean {
  if (place === undefined || place.home === undefined || !path.isAbsolute(place.home) || !path.isAbsolute(file)) return false;
  try {
    const real = (place.realpath ?? realpathSync)(file);
    const onDisk = statSync(real);
    if (onDisk.dev !== handle.dev || onDisk.ino !== handle.ino) return false;
    if (!within(realpathSync(place.home), real)) return false;
    const { mirrorsRoot, workspaceRoot, tempRoot } = cacheRootsFor({ home: place.home, platform: place.platform, xdgCacheHome: place.xdgCacheHome });
    return ![mirrorsRoot, workspaceRoot, tempRoot].some((root) => pathsOverlap(root, real));
  } catch {
    // fx-swallow-ok: a path that cannot be resolved is not accepted; the closed code carries no error text
    return false;
  }
}

/**
 * Reads the secret from the file `file` names. The file is opened without following a link and judged by the open handle (a plain
 * file, in an allowed place, owned by `uid`, mode 0600 or stricter), so the file cannot change between the check and the read.
 * `file` unset or empty is "unset".
 */
export function loadBypass(file: string | undefined, uid: number | undefined, place?: BypassPlace): Bypass {
  if (file === undefined || file === "") return { kind: "unset" };
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // fx-swallow-ok: a link at the path (ELOOP) is "not regular"; anything else is "unreadable"; the error text may carry the path
    return { kind: "refused", code: (error as { code?: string }).code === "ELOOP" ? "bypass_file_not_regular" : "bypass_file_unreadable" };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { kind: "refused", code: "bypass_file_not_regular" };
    if (!locationOk(file, info, place)) return { kind: "refused", code: "bypass_file_location" };
    if (uid === undefined || info.uid !== uid) return { kind: "refused", code: "bypass_file_not_owned" };
    if ((info.mode & 0o077) !== 0) return { kind: "refused", code: "bypass_file_mode" };
    if (info.size > 4096) return { kind: "refused", code: "bypass_file_invalid" };
    const secret = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (secret === "" || secret.length > MAX_SECRET_LENGTH || !/^[\x21-\x7e]+$/.test(secret)) return { kind: "refused", code: "bypass_file_invalid" };
    return { kind: "ok", secret };
  } catch {
    // fx-swallow-ok: the read failed after the open; reported as the closed code, never with the error text
    return { kind: "refused", code: "bypass_file_unreadable" };
  } finally {
    closeSync(fd);
  }
}

/**
 * The header to add to a request to `url`, or none. It is added only when `url` has exactly the registered `origin` (scheme, host and
 * port), so a request to any other host never carries it. Every caller passes `redirect: "error"` or `"manual"`, so the header cannot
 * travel to a redirect target.
 */
export function bypassHeaders(secret: string | undefined, origin: string, url: string): Record<string, string> {
  if (secret === undefined) return {};
  let target: string;
  try {
    target = new URL(url).origin;
  } catch {
    // fx-swallow-ok: an address that does not parse gets no header
    return {};
  }
  return target === origin ? { [BYPASS_HEADER]: secret } : {};
}

/** Throws the closed refusal when the file cannot be used; otherwise the secret, or undefined when none is set. */
export function requireUsable(bypass: Bypass | undefined): string | undefined {
  if (bypass?.kind === "refused") throw new CliError(bypassRefusalText(bypass.code));
  return bypassSecret(bypass);
}

/** The secret when one was loaded, else undefined (a refusal included: nothing is sent). */
export function bypassSecret(bypass: Bypass | undefined): string | undefined {
  return bypass?.kind === "ok" ? bypass.secret : undefined;
}
