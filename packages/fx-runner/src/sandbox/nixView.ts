import { NIX_STORE } from "../job/nixShellEnv.js";

/**
 * D#6 R7c: what a job's sandbox sees of Nix. The directory of the Nix daemon's socket is hidden from every job, whether or not the repo has a dev shell:
 * a process that could connect to it could ask the daemon to build, which is exactly what the dev shell step does outside the sandbox so that the job never has to.
 * A job that was given a dev shell is also granted a read of `/nix/store`, the one place its tools live. Both are constants, not job input.
 */
export const NIX_DAEMON_SOCKET_DIR = "/nix/var/nix/daemon-socket";

/** Adds the daemon-socket denial, and the store read when `withStore`, to a settings block the builder has already accepted. */
export function applyNixView(block: Record<string, unknown>, withStore: boolean): void {
  const fs = block["filesystem"] as { denyRead: string[]; allowRead: string[] };
  if (!fs.denyRead.includes(NIX_DAEMON_SOCKET_DIR)) fs.denyRead.push(NIX_DAEMON_SOCKET_DIR);
  if (withStore && !fs.allowRead.includes(NIX_STORE)) fs.allowRead.push(NIX_STORE);
}

/**
 * D#6 R7c fix round 2: the view the Nix CLIENT runs in during the dev shell step. The client reads files as the runner user, so a `flake.nix` that fetches
 * `path:/abs`, a `file://` url or an input missing from the lock would copy any readable host file into the world-readable store. The answer is not a
 * longer list of things to refuse but a short list of the only things that exist: an allowlist, built into a bubblewrap root that starts empty. Inside it
 * are the repo mirror and `/nix/store` (both read-only), the daemon socket directory, the machine's nix configuration files, the CA bundle and resolver
 * files, and an empty `/tmp` (the client's HOME and TMPDIR). Not the runner's home, keys, other repos or worktrees, the job workspaces, or the host's
 * `/tmp`. The step's own data directory is not in it either: the client's work needs nothing from it.
 */
export interface NixViewFs {
  exists(target: string): boolean;
  isDir(target: string): boolean;
  isFile(target: string): boolean;
  /** The names in a directory, or an empty list. */
  list(target: string): string[];
}

/** The places a CA bundle is looked for; each that exists is bound as a single file, and the first is named to the client. */
export const NIX_CA_BUNDLES: readonly string[] = Object.freeze(["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-bundle.crt", "/etc/pki/tls/certs/ca-bundle.crt"]);
/** Resolver files, bound one by one when they exist. */
export const NIX_NET_FILES: readonly string[] = Object.freeze(["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]);
/** Read-only system directories shown only when `git` is not in the store (its libraries live there). */
export const SYSTEM_LIBS: readonly string[] = Object.freeze(["/usr/lib", "/usr/libexec", "/lib", "/lib64"]);
export const NIX_VIEW_HOME = "/tmp/home";
export const NIX_VIEW_TMP = "/tmp";

export interface NixViewInput {
  /** The nix binary's real path (links resolved). Under `/nix/store` it needs no extra bind; elsewhere its own directory is bound read-only. */
  nixBin: string;
  /**
   * The real path of `git`, which nix runs to read a mirror. Under `/nix/store` it needs nothing more; elsewhere its directory and the system's library
   * directories are bound read-only (programs and libraries, nothing of the runner's). Absent: nix runs without git and the fetch of a mirror fails closed.
   */
  gitBin?: string;
  /** The repo mirror's directory, bound read-only at the same path. */
  mirrorDir: string;
  /** Where the machine's nix configuration lives. Always shown to the client at `/etc/nix`. */
  etcNixDir?: string;
}

export interface NixView {
  /** The bubblewrap options, up to but not including the `--`. */
  args: string[];
  /** The only environment the client gets inside the view (set with `--setenv`, after `--clearenv`). */
  env: Record<string, string>;
}

/** An absolute path with no `..` segment, no NUL and no newline: the only kind that is bound. */
function plainAbsolute(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0") && !value.includes("\n") && !value.split("/").includes("..");
}

function dirOf(file: string): string {
  return file.slice(0, file.lastIndexOf("/")) || "/";
}

/**
 * The view for one client call, or `undefined` when it cannot be built (no daemon socket to reach, no store, a path that is not plain). The caller then
 * skips the dev shell: there is no unsandboxed fallback anywhere.
 */
export function buildNixView(input: NixViewInput, fsx: NixViewFs): NixView | undefined {
  const etcNix = input.etcNixDir ?? "/etc/nix";
  if (![input.nixBin, input.mirrorDir, etcNix, ...(input.gitBin === undefined ? [] : [input.gitBin])].every(plainAbsolute)) return undefined;
  if (!fsx.isDir(NIX_STORE) || !fsx.isDir(NIX_DAEMON_SOCKET_DIR) || !fsx.exists(`${NIX_DAEMON_SOCKET_DIR}/socket`) || !fsx.isDir(input.mirrorDir)) return undefined;
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--clearenv",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", NIX_VIEW_TMP, "--dir", NIX_VIEW_HOME,
    "--ro-bind", NIX_STORE, NIX_STORE,
    "--ro-bind", NIX_DAEMON_SOCKET_DIR, NIX_DAEMON_SOCKET_DIR,
    "--ro-bind", input.mirrorDir, input.mirrorDir,
  ];
  if (!input.nixBin.startsWith(`${NIX_STORE}/`)) args.push("--ro-bind", dirOf(input.nixBin), dirOf(input.nixBin));
  if (input.gitBin !== undefined && !input.gitBin.startsWith(`${NIX_STORE}/`)) {
    args.push("--ro-bind", dirOf(input.gitBin), dirOf(input.gitBin));
    for (const dir of SYSTEM_LIBS) if (fsx.isDir(dir)) args.push("--ro-bind", dir, dir);
  }
  // The configuration files one by one: they are often links to a store path the view cannot otherwise see, and bubblewrap binds what a link points to.
  for (const name of fsx.list(etcNix)) {
    if (name === "" || name === "." || name === ".." || name.includes("/")) continue;
    if (fsx.isFile(`${etcNix}/${name}`)) args.push("--ro-bind", `${etcNix}/${name}`, `/etc/nix/${name}`);
  }
  for (const file of NIX_NET_FILES) if (fsx.isFile(file)) args.push("--ro-bind", file, file);
  for (const file of NIX_CA_BUNDLES) if (fsx.isFile(file)) args.push("--ro-bind", file, file);
  const bundle = NIX_CA_BUNDLES.find((candidate) => fsx.isFile(candidate));
  const env: Record<string, string> = {
    PATH: [...new Set([dirOf(input.nixBin), ...(input.gitBin === undefined ? [] : [dirOf(input.gitBin)])])].join(":"),
    HOME: NIX_VIEW_HOME,
    TMPDIR: NIX_VIEW_TMP,
    XDG_CACHE_HOME: `${NIX_VIEW_HOME}/.cache`,
    LANG: "C",
    NIX_CONF_DIR: "/etc/nix",
    // Without /nix/var/nix/db in the view nix would pick the local store and try to write /nix/store itself; the daemon (its socket is in the view) does the writing.
    NIX_REMOTE: "daemon",
    ...(bundle === undefined ? {} : { NIX_SSL_CERT_FILE: bundle }),
  };
  return { args, env };
}

/** The argument vector that starts `command` in a view: bubblewrap's options, then the environment, then the command. */
export function viewedArgv(view: NixView, command: string, args: readonly string[]): string[] {
  const setenv = Object.entries(view.env).flatMap(([name, value]) => ["--setenv", name, value]);
  return [...view.args, ...setenv, "--", command, ...args];
}
