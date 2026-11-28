/** The platform support table lives in the protocol package, so the cloud can read the same rows (D#587 B-7c); this file keeps the runner's one import path. */
export { MACOS_PREVIEW_LABEL, MACOS_PREVIEW_NOTICE, PLATFORM_SUPPORT, WINDOWS_UNSUPPORTED_NOTICE, WSL1_CONVERT_NOTICE, WSL2_NOT_CLEARED_NOTICE, WSL2_VM_NOTICE, platformRow, refusalNotice } from "@fulcrumaxe/runner-protocol";
export type { PlatformId, PlatformRow, SupportStatus } from "@fulcrumaxe/runner-protocol";
