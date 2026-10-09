import { WINDOWS_UNSUPPORTED_NOTICE } from "../platformSupport.js";
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

/** What the runner tells a user on native Windows, WSL1 or WSL2: one copy for all three. */
export const WINDOWS_REFUSAL = WINDOWS_UNSUPPORTED_NOTICE;

export interface PlatformProbe {
  /** The operating system as `os.platform()` names it; asked of the machine when left out. */
  platform?: string;
  /** The kernel release as `os.release()` gives it (on Linux, the kernel's own release string); asked of the machine when left out. */
  osrelease?: string;
}

/**
 * What a Linux kernel release string says about Windows. WSL2 reports a "microsoft-standard" kernel (older builds omit
 * "WSL2" from the string); WSL1 reports a bare "Microsoft" kernel. Kept apart from the refusal so WSL2 support can
 * reuse it; v1 refuses both.
 */
export function classifyLinuxKernel(release: string): "linux" | "wsl1" | "wsl2" {
  if (/microsoft-standard|wsl2/i.test(release)) return "wsl2";
  if (/microsoft/i.test(release)) return "wsl1";
  return "linux";
}

/**
 * Which supported platform this is, or a refusal. Native Windows, WSL1 and WSL2 are refused: v1 supports macOS and
 * Linux only, and there is never an unsandboxed path. (WSL2 has bubblewrap, but the automounted Windows drives are
 * readable and Windows programs can be started from inside it, which the job sandbox does not cover yet.)
 */
export function detectPlatform(probe: PlatformProbe): Platform {
  const platform = probe.platform ?? osPlatform();
  if (platform === "win32") throw new SandboxRefused("windows_unsupported", WINDOWS_REFUSAL);
  if (platform === "darwin") return "macos";
  if (platform !== "linux") throw new SandboxRefused("unsupported_platform", platform);
  const kernel = classifyLinuxKernel(probe.osrelease ?? osRelease());
  if (kernel === "wsl2") throw new SandboxRefused("wsl2_unsupported", WINDOWS_REFUSAL);
  if (kernel === "wsl1") throw new SandboxRefused("wsl1_unsupported", WINDOWS_REFUSAL);
  return "linux";
}
