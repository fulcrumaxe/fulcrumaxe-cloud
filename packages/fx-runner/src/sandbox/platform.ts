import { platform as osPlatform, release as osRelease } from "node:os";

/** Why a machine cannot run jobs at all. Closed set; each is a reason the runner can report. */
export type SandboxRefusalCode = "windows_unsupported" | "wsl1_unsupported" | "unsupported_platform" | "bubblewrap_missing" | "socat_missing";

/** Thrown before any job is claimed when no isolation tier can run here. The message never carries a value from a job. */
export class SandboxRefused extends Error {
  constructor(readonly code: SandboxRefusalCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "SandboxRefused";
  }
}

export type Platform = "macos" | "linux" | "wsl2";

/** What the runner tells a Windows user. */
export const WINDOWS_REFUSAL = "fx-runner does not run on Windows directly. Install WSL2 and run the Linux install inside it.";

export interface PlatformProbe {
  /** The operating system as `os.platform()` names it; asked of the machine when left out. */
  platform?: string;
  /** The kernel release as `os.release()` gives it (on Linux, the kernel's own release string); asked of the machine when left out. */
  osrelease?: string;
}

/**
 * Which supported platform this is, or a refusal. Native Windows and WSL1 are refused: neither has a sandbox path, and
 * there is never an unsandboxed one. WSL2 reports a "microsoft-standard" kernel (older builds omit "WSL2" from the
 * string); WSL1 reports a bare "Microsoft" kernel.
 */
export function detectPlatform(probe: PlatformProbe): Platform {
  const platform = probe.platform ?? osPlatform();
  if (platform === "win32") throw new SandboxRefused("windows_unsupported", WINDOWS_REFUSAL);
  if (platform === "darwin") return "macos";
  if (platform !== "linux") throw new SandboxRefused("unsupported_platform", platform);
  const release = probe.osrelease ?? osRelease();
  if (/microsoft-standard|wsl2/i.test(release)) return "wsl2";
  if (/microsoft/i.test(release)) throw new SandboxRefused("wsl1_unsupported", WINDOWS_REFUSAL);
  return "linux";
}
