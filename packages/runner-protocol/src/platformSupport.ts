/**
 * The macOS label, in one place. `fx-runner doctor` prints `MACOS_PREVIEW_NOTICE` and the README states it (a test reads the
 * README and compares, and checks that no other file in `src/` spells the label). Removing it is a later copy-only change, made
 * once the manual Seatbelt check has passed.
 */
export const MACOS_PREVIEW_LABEL = "preview, not yet verified";

export const MACOS_PREVIEW_NOTICE = `macOS support is a ${MACOS_PREVIEW_LABEL}: jobs run in Claude Code's own sandbox, which has not been proven on macOS yet.`;

/**
 * What the runner says on native Windows, and what `install.sh` says when it is run there (a test compares the two, and the
 * README). The installer proceeds on WSL2 when systemd is PID 1; WSL1 gets the conversion notice below.
 */
export const WINDOWS_UNSUPPORTED_NOTICE = "fx-runner does not support native Windows. Install it inside WSL2, or on Linux or macOS.";

/** What the runner says when WSL2 is supported but one of its safety checks or live probes has not passed on this machine. */
export const WSL2_NOT_CLEARED_NOTICE = "fx-runner on WSL2 starts only when every safety check and live probe passes, and one has not. Run fx-runner doctor to see which, then fix it.";

/** What doctor prints for WSL2's VM mode: jobs run in the OS sandbox only. */
export const WSL2_VM_NOTICE = "VM mode not supported";

/** How a platform stands. `refused` is a platform the runner recognises and turns away by name until its safety checks ship; `not_supported` has no plan in this build. */
export type SupportStatus = "supported" | "preview" | "refused" | "not_supported";

/** A platform the runner tells apart. */
export type PlatformId = "macos" | "linux" | "windows" | "wsl2" | "wsl1";

/**
 * One row per platform: the single place that says how the runner stands there. Doctor, the runner's refusals and the README matrix all read it,
 * and a test fails when a copy disagrees. The cloud's runner screen reads the same rows, so a platform never shows "supported" before its proof passes.
 * The shape is read by other packages: add fields, never rename or remove one.
 */
export interface PlatformRow {
  id: PlatformId;
  /** The name in the README matrix's first column. */
  name: string;
  status: SupportStatus;
  /** The matrix's second column, exactly. */
  label: string;
  /** The refusal code the runner gives here: on a refused or unsupported platform always, on a supported platform whose safety checks have not passed (WSL2); absent where nothing gates the start. */
  refusalCode?: "windows_unsupported" | "wsl1_unsupported" | "wsl2_unsupported";
  /** What the runner prints when it refuses; absent where the platform runs jobs. */
  notice?: string;
  /** Set where VM mode is not offered (WSL2: jobs run in the OS sandbox only); what doctor prints for it. Added in B-9b. */
  vmNotice?: string;
}

/** What the runner says for WSL1: it cannot run the sandbox at all, and a conversion is the only way forward. */
export const WSL1_CONVERT_NOTICE = "fx-runner does not support WSL1. Convert the distribution with: wsl --set-version <distro> 2 (WSL2 is supported and runs only when its safety checks pass). Linux and macOS are supported.";

export const PLATFORM_SUPPORT: readonly PlatformRow[] = Object.freeze([
  { id: "macos", name: "macOS arm64 and x64", status: "preview", label: `supported as a **${MACOS_PREVIEW_LABEL}** (see below)` },
  { id: "linux", name: "Linux x64 and arm64", status: "supported", label: "supported" },
  { id: "windows", name: "Native Windows", status: "not_supported", label: "not supported", refusalCode: "windows_unsupported", notice: WINDOWS_UNSUPPORTED_NOTICE },
  { id: "wsl2", name: "WSL2", status: "supported", label: "supported, OS sandbox only, NAT networking (see below)", refusalCode: "wsl2_unsupported", notice: WSL2_NOT_CLEARED_NOTICE, vmNotice: WSL2_VM_NOTICE },
  { id: "wsl1", name: "WSL1", status: "not_supported", label: "not supported", refusalCode: "wsl1_unsupported", notice: WSL1_CONVERT_NOTICE },
] satisfies PlatformRow[]);

/** The row for one platform. */
export function platformRow(id: PlatformId): PlatformRow {
  const row = PLATFORM_SUPPORT.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no platform row for ${id}`);
  return row;
}

/** The refusal text for a row that refuses. */
export function refusalNotice(id: "windows" | "wsl1" | "wsl2"): string {
  return platformRow(id).notice ?? WINDOWS_UNSUPPORTED_NOTICE;
}
