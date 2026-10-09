/**
 * The sandbox probe (D#6 R4a-5, correction C16): can this machine start a command inside the sandbox a job gets? `doctor` asks it, and the
 * answer is a pass or a failure with one reason code from a closed set and a one-line reason.
 *
 * The Claude Code shell sandbox only runs on a model turn, so the probe does not use the agent CLI. It starts the machine's own sandbox tool
 * directly (bubblewrap on Linux, `sandbox-exec` on macOS) with arguments translated from the object `sandboxSettings()` builds, the
 * same function the job path uses, and runs one fixed command that prints a marker. There is no network in it (the network namespace is
 * unshared, the macOS profile denies it), no model request, and no fallback: a machine that fails here is told so, and runs nothing.
 *
 * Nothing in this file starts a process or reads the machine itself: the host (`SandboxHost`) does both, so a test can stand in for any distro.
 */
import path from "node:path";
import { printable } from "../commands/logs.js";
import { cacheRootsFor } from "../daemon/mirror.js";
import { cleanEnv } from "../job/cleanEnv.js";
import { SandboxRefused } from "./platform.js";
import { sandboxSettings } from "./sandboxSettings.js";
import { resolveSandboxTools } from "./select.js";

/** Why the sandbox cannot start. Closed set; the reason code is the only detail that may leave the machine. */
export const SANDBOX_REASONS = ["bwrap_missing", "socat_missing", "userns_disabled", "apparmor_userns_restricted", "probe_failed_other"] as const;
export type SandboxReason = (typeof SANDBOX_REASONS)[number];

export type SandboxProbeResult =
  | { ok: true; tool: "bubblewrap" | "seatbelt" }
  | { ok: false; reason: SandboxReason; detail: string; /** The bubblewrap the probe found and ran, when it got that far: what an AppArmor profile has to name. */ bwrapPath?: string };

/** What the probe needs from the machine. Only the program's entry point fills it in (`createSandboxHost`); tests bring fakes. */
export interface SandboxHost {
  /** Starts `command args` with exactly `env`, no shell, and answers when it ends or the time limit passes. */
  run(command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  isDir(target: string): boolean;
  isFile(target: string): boolean;
  /** The text of a small file, or undefined when it cannot be read. */
  readText(target: string): string | undefined;
  /** The value of a kernel setting by its dotted name (`user.max_user_namespaces`), or undefined when the machine has no such setting or it cannot be read. */
  sysctl(name: string): Promise<string | undefined>;
}

export interface SandboxProbeInput {
  platform: NodeJS.Platform;
  home: string;
  stateDir: string;
  /** The directory holding the agent binary; the state directory's `engine` subdirectory stands in when there is no binary. */
  binaryDir: string;
  xdgCacheHome?: string | undefined;
  /** Where bubblewrap and socat are looked for. Default: the search path of the clean environment (what `run` uses too, unless a test sets one). */
  searchPath?: string | undefined;
}

/** What the test command prints. */
export const PROBE_MARKER = "fx-sandbox-ok";
const PROBE_TIMEOUT_MS = 10_000;
const DETAIL_MAX = 160;

/** The settings a job would get, for a workspace and temp directory that stand in for a job's, built by the one shared function. */
export function probeSettings(input: SandboxProbeInput): Record<string, unknown> {
  const { mirrorsRoot, workspaceRoot, tempRoot } = cacheRootsFor({ home: input.home, platform: input.platform, xdgCacheHome: input.xdgCacheHome });
  return sandboxSettings({
    workspace: path.join(workspaceRoot, "fx-probe"),
    tempDir: path.join(tempRoot, "fx-probe"),
    home: input.home,
    stateDir: input.stateDir,
    binaryDir: input.binaryDir,
    workspaceRoot,
    tempRoot,
    mirrorsRoot,
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function fsBlock(settings: Record<string, unknown>): Record<string, unknown> {
  const block = settings.filesystem;
  return block !== null && typeof block === "object" ? (block as Record<string, unknown>) : {};
}

/** The paths in `credentials.files` whose mode is `deny`. */
function deniedCredentialFiles(settings: Record<string, unknown>): string[] {
  const block = settings.credentials;
  const files = block !== null && typeof block === "object" ? (block as Record<string, unknown>).files : undefined;
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry: unknown) => {
    const item = entry as { path?: unknown; mode?: unknown } | null;
    return item !== null && typeof item === "object" && item.mode === "deny" && typeof item.path === "string" ? [item.path] : [];
  });
}

/**
 * The bubblewrap arguments for the filesystem and network rules in `settings`: a read-only view of the machine, no network, a hidden copy of
 * every denied-read directory that exists, then the allowed reads and writes laid back over it. A path that is not there is skipped
 * (`-try`), so the probe creates nothing on the machine. Ends before the command.
 */
export function bwrapArgs(settings: Record<string, unknown>, isDir: (target: string) => boolean, isFile?: (target: string) => boolean): string[] {
  const fs = fsBlock(settings);
  const hidden = [...new Set(stringList(fs.denyRead))].filter((dir) => isDir(dir));
  // A directory under another hidden one is already hidden with it.
  const top = hidden.filter((dir) => !hidden.some((other) => other !== dir && dir.startsWith(`${other}${path.sep}`)));
  // The installed agent CLI starts bubblewrap with a user namespace of its own and a fresh process-table mount, so the probe does too:
  // on a host that masks the process table (a container, a nested host) it then fails where a job would. The exact path `/proc` is the
  // one place this package's sources may name it (test/helpers/envGuard.ts); a path below it is still banned.
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const dir of top) args.push("--tmpfs", dir);
  for (const dir of stringList(fs.allowRead)) args.push("--ro-bind-try", dir, dir);
  for (const dir of stringList(fs.allowWrite)) args.push("--bind-try", dir, dir);
  // A denied file inside a re-allowed directory (a toolchain prefix's system-wide npm config) is covered last, so the deny wins over the allow.
  // Only where the caller can say a file exists: a bind onto a missing file cannot be made inside a read-only directory.
  if (isFile !== undefined) {
    const allowed = [...stringList(fs.allowRead), ...stringList(fs.allowWrite)];
    const denied = new Set([...stringList(fs.denyRead), ...deniedCredentialFiles(settings)]);
    for (const file of denied) if (allowed.some((dir) => file.startsWith(`${dir}${path.sep}`)) && isFile(file)) args.push("--ro-bind", "/dev/null", file);
  }
  return args;
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The Seatbelt profile for the same rules: everything allowed except the network and every write, then the writes, then the denied reads and
 * the allowed reads laid over them. Beginning with everything allowed keeps the shell startable on macOS releases this project has not seen; the
 * rules that matter are the denials. The macOS path is a preview (`MACOS_PREVIEW_NOTICE`).
 */
export function seatbeltProfile(settings: Record<string, unknown>): string {
  const fs = fsBlock(settings);
  const subpaths = (values: string[]): string => values.map((value) => `(subpath ${quoted(value)})`).join(" ");
  const rules = ["(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)", '(allow file-write* (literal "/dev/null"))'];
  const writes = stringList(fs.allowWrite);
  if (writes.length > 0) rules.push(`(allow file-write* ${subpaths(writes)})`);
  const denied = stringList(fs.denyRead);
  if (denied.length > 0) rules.push(`(deny file-read* ${subpaths(denied)})`);
  const reads = [...stringList(fs.allowRead), ...writes];
  if (reads.length > 0) rules.push(`(allow file-read* ${subpaths(reads)})`);
  return rules.join("");
}

async function readNumber(host: SandboxHost, name: string): Promise<number | undefined> {
  const text = (await host.sysctl(name))?.trim();
  return text !== undefined && /^-?\d{1,10}$/.test(text) ? Number(text) : undefined;
}

/** The first non-empty line of the tool's error output, through the shared `printable` (control and bidirectional characters dropped, credential shapes redacted, the length cut). */
function firstLine(stderr: string): string {
  return stderr.split(/[\r\n\u2028\u2029]/).map((part) => printable(part, DETAIL_MAX).trim()).find((part) => part !== "") ?? "";
}

/** The shape bubblewrap prints when the kernel or AppArmor refuses it the user namespace's ID map: the only failure that is blamed on the AppArmor switch. */
const USERNS_DENIED = /setting up uid map/i;

const REASON_TEXT: Record<Exclude<SandboxReason, "probe_failed_other">, string> = {
  bwrap_missing: "bubblewrap (bwrap) is not installed",
  socat_missing: "socat is not installed",
  userns_disabled: "this kernel has unprivileged user namespaces switched off, and bubblewrap needs them",
  apparmor_userns_restricted: "AppArmor restricts unprivileged user namespaces here, and bubblewrap needs them",
};

const failure = (reason: SandboxReason, detail?: string): SandboxProbeResult => ({ ok: false, reason, detail: detail ?? REASON_TEXT[reason as keyof typeof REASON_TEXT] });

/** Why the tool failed, read from the machine's own switches first and the tool's first error line last. */
async function classify(host: SandboxHost, stderr: string, bwrapPath: string): Promise<SandboxProbeResult> {
  if ((await readNumber(host, "user.max_user_namespaces")) === 0 || (await readNumber(host, "kernel.unprivileged_userns_clone")) === 0) return failure("userns_disabled");
  if ((await readNumber(host, "kernel.apparmor_restrict_unprivileged_userns")) === 1 && USERNS_DENIED.test(stderr)) return { ...failure("apparmor_userns_restricted"), bwrapPath } as SandboxProbeResult;
  return failure("probe_failed_other", firstLine(stderr) || "the test command failed with no message");
}

/** Runs the test command in the job's sandbox rules. It never throws for what the machine does; it makes no model request and no network request. */
export async function probeSandbox(input: SandboxProbeInput, host: SandboxHost): Promise<SandboxProbeResult> {
  const settings = probeSettings(input);
  // Only the search path goes into the test: no credential, no token, nothing else of this shell.
  const env: Record<string, string> = { PATH: input.searchPath ?? cleanEnv({ mode: "subscription" }).PATH ?? "", LC_ALL: "C" };
  const command = ["/bin/sh", "-c", `printf %s ${PROBE_MARKER}`];
  let tool: string;
  let args: string[];
  let kind: "bubblewrap" | "seatbelt";
  if (input.platform === "darwin") {
    tool = "/usr/bin/sandbox-exec";
    kind = "seatbelt";
    args = ["-p", seatbeltProfile(settings), ...command];
    if (!host.isFile(tool)) return failure("probe_failed_other", "sandbox-exec is not at /usr/bin/sandbox-exec");
  } else {
    kind = "bubblewrap";
    try {
      // Absolute paths found on the search path, and a refusal for a missing tool, exactly as the tier check gives them.
      const tools = resolveSandboxTools(env.PATH ?? "", { platform: input.platform });
      if (tools === undefined) return failure("probe_failed_other", "no sandbox tool is needed here");
      tool = tools.bwrap;
    } catch (error) {
      if (!(error instanceof SandboxRefused)) throw error;
      if (error.code === "bubblewrap_missing") return failure("bwrap_missing");
      if (error.code === "socat_missing") return failure("socat_missing");
      return failure("probe_failed_other", `this platform is not supported (${error.code})`);
    }
    args = [...bwrapArgs(settings, (target) => host.isDir(target)), "--", ...command];
  }
  const outcome = await host.run(tool, args, env, PROBE_TIMEOUT_MS);
  if (outcome.timedOut) return failure("probe_failed_other", "the test command did not finish in 10 seconds");
  if (outcome.code === 0 && outcome.stdout.trim() === PROBE_MARKER) return { ok: true, tool: kind };
  if (input.platform === "darwin") return failure("probe_failed_other", firstLine(outcome.stderr) || "Seatbelt could not run the test command");
  if (outcome.code === null) return failure("probe_failed_other", "the sandbox tool could not be started");
  return await classify(host, outcome.stderr, tool);
}

/** What `doctor` knows about the machine; the probe's own input is made from it. */
export interface MachineFacts {
  platform: NodeJS.Platform;
  home: string | undefined;
  stateDir: string;
  /** The agent binary's absolute path, when one was found. */
  binaryPath: string | undefined;
  xdgCacheHome?: string | undefined;
  searchPath?: string | undefined;
}

/** `probeSandbox` for the facts `doctor` has. A home directory that is not known or not absolute is a failure with a reason, never a skipped check. */
export async function probeMachine(facts: MachineFacts, host: SandboxHost): Promise<SandboxProbeResult> {
  if (facts.home === undefined || !path.isAbsolute(facts.home)) return failure("probe_failed_other", "the home directory is not known (HOME is not set)");
  const binaryDir = facts.binaryPath === undefined ? path.join(facts.stateDir, "engine") : path.dirname(facts.binaryPath);
  return probeSandbox({ platform: facts.platform, home: facts.home, stateDir: facts.stateDir, binaryDir, xdgCacheHome: facts.xdgCacheHome, searchPath: facts.searchPath }, host);
}
