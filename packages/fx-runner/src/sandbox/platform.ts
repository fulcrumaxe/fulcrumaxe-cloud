import { WINDOWS_UNSUPPORTED_NOTICE, refusalNotice } from "../platformSupport.js";
import { platform as osPlatform, release as osRelease } from "node:os";

/** Why a machine cannot run jobs at all. Closed set; each is a reason the runner can report. */
export type SandboxRefusalCode = "windows_unsupported" | "wsl1_unsupported" | "wsl2_unsupported" | "unsupported_platform" | "bubblewrap_missing" | "socat_missing";

/** Thrown before any job is claimed when no isolation tier can run here. The message never carries a value from a job. */
export class SandboxRefused extends Error {
  constructor(readonly code: SandboxRefusalCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "SandboxRefused";
  }
}

/** The platforms a job can run on in v1. WSL2 is not among them: see `wsl2_unsupported`. */
export type Platform = "macos" | "linux";

/** What the runner tells a user on native Windows or WSL2 (WSL1 has its own row in `platformSupport.ts`). */
export const WINDOWS_REFUSAL = WINDOWS_UNSUPPORTED_NOTICE;

/**
 * The two things about WSL2 that only the machine can say. The program's entry point (`bin/fx-runner.mjs`) is the one place that names the
 * kernel's files, so nothing in `src` builds a path into the process table.
 */
export interface WslMachine {
  /** Whether the `WSLInterop` or `WSLInterop-late` binfmt entry exists (true when the machine cannot tell: fail closed): WSL2's init registers it so Windows programs can be started from Linux. A WSL2 kernel with a custom name still has it. */
  interopEntry(): boolean;
  /** The text of the kernel's mount table, or undefined when it cannot be read. */
  mountinfo(): string | undefined;
  /** The path with every symlink in its existing part resolved (a part that is not there yet is kept as written), or undefined when that cannot be done. Absent: the path stands as written. */
  realPath?(target: string): string | undefined;
  /**
   * Set by `clearWsl` (wslGate.ts) and nowhere else, when every WSL2 check and live probe passed on this machine in this process.
   * Absent means not cleared, and `detectPlatform` refuses WSL2.
   */
  clearance?: WslClearance | undefined;
}

export interface WslClearance {
  /** Paths added to both the read and the write deny list of every job. */
  denyPaths: readonly string[];
  /**
   * Whether the networking mode was known to be NAT when the machine was cleared. Mirrored mode (or an answer that could not be had) shares loopback and the host address with
   * Windows, so a host-sandbox job and a host-guest command are refused (`wsl_mirrored_networking`) unless this is true. It is read again for every job, because the engine
   * a job runs in can change after start (a `microvm` setting switched to `os_sandbox`), and a clearance granted for a microVM run says nothing about the host sandbox.
   */
  nat: boolean;
}

/** The WSL2 facts of `PlatformProbe`, read from the machine object in one place, so no caller can forget the clearance. */
export function wslFacts(wsl: WslMachine | undefined): { wslInterop: boolean | undefined; wslCleared: boolean } {
  return { wslInterop: wsl?.interopEntry(), wslCleared: wsl?.clearance !== undefined };
}

/** The names WSL2's init gives the interop entry. Either one means WSL2 with interop on. */
export const INTEROP_ENTRY_NAMES: readonly string[] = Object.freeze(["WSLInterop", "WSLInterop-late"]);

/**
 * Whether an interop entry is there, given a stat of one entry by name that throws when it cannot be done. Only "not there" (ENOENT, ENOTDIR)
 * means absent: any other error cannot show the entry is absent, so it counts as present and the runner refuses (fail closed).
 */
export function interopEntryPresent(statEntry: (name: string) => void): boolean {
  return INTEROP_ENTRY_NAMES.some((name) => {
    try {
      statEntry(name);
      return true;
    } catch (error) {
      // fx-swallow-ok: the error decides the answer: only a missing entry is "absent"
      return !(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
    }
  });
}

export interface PlatformProbe {
  /** The operating system as `os.platform()` names it; asked of the machine when left out. */
  platform?: string;
  /** The kernel release as `os.release()` gives it (on Linux, the kernel's own release string); asked of the machine when left out. */
  osrelease?: string;
  /** Whether the `WSLInterop` or `WSLInterop-late` entry exists (`WslMachine.interopEntry`; true also when the machine could not tell). Left out, it is taken as absent. */
  wslInterop?: boolean | undefined;
  /** Whether `clearWsl` found every WSL2 check and live probe passing (`WslMachine.clearance`). Left out, WSL2 is refused. */
  wslCleared?: boolean | undefined;
}

/**
 * What a Linux kernel says about Windows. WSL2 reports a "microsoft-standard" kernel (older builds omit "WSL2" from the string) or, on a
 * custom-named kernel, still has the `WSLInterop` entry; WSL1 reports a bare "Microsoft" kernel and has no such entry. A bare "Microsoft"
 * kernel that does have the entry is called WSL2: both are refused, and the stricter reading wins. `WSL_DISTRO_NAME` is never consulted:
 * a variable anyone can set is no evidence of the kernel.
 */
export function classifyLinuxKernel(release: string, interopPresent = false): "linux" | "wsl1" | "wsl2" {
  if (/microsoft-standard|wsl2/i.test(release) || interopPresent) return "wsl2";
  if (/microsoft/i.test(release)) return "wsl1";
  return "linux";
}

/** The kernel's own answer for a Linux machine: the probe's values where given, the machine's kernel string otherwise. */
export function linuxKernel(probe: PlatformProbe): "linux" | "wsl1" | "wsl2" {
  return classifyLinuxKernel(probe.osrelease ?? osRelease(), probe.wslInterop === true);
}

/**
 * Which supported platform this is, or a refusal. Native Windows and WSL1 are refused, and so is WSL2 until its checks and live
 * probes have passed on this machine (`wslCleared`): its Windows drives are readable and Windows programs can be started from
 * inside it unless those are shut. There is never an unsandboxed path.
 */
export function detectPlatform(probe: PlatformProbe): Platform {
  const platform = probe.platform ?? osPlatform();
  if (platform === "win32") throw new SandboxRefused("windows_unsupported", refusalNotice("windows"));
  if (platform === "darwin") return "macos";
  if (platform !== "linux") throw new SandboxRefused("unsupported_platform", platform);
  const kernel = linuxKernel(probe);
  if (kernel === "wsl2" && probe.wslCleared !== true) throw new SandboxRefused("wsl2_unsupported", refusalNotice("wsl2"));
  if (kernel === "wsl1") throw new SandboxRefused("wsl1_unsupported", refusalNotice("wsl1"));
  // WSL2 only gets here cleared: it runs as Linux in the OS sandbox, never in a VM.
  return "linux";
}
