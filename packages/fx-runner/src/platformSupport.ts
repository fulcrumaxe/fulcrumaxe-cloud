/**
 * The macOS label, in one place. `fx-runner doctor` prints `MACOS_PREVIEW_NOTICE` and the README states it (a test reads the
 * README and compares, and checks that no other file in `src/` spells the label). Removing it is a later copy-only change, made
 * once the manual Seatbelt check has passed.
 */
export const MACOS_PREVIEW_LABEL = "preview, not yet verified";

export const MACOS_PREVIEW_NOTICE = `macOS support is a ${MACOS_PREVIEW_LABEL}: jobs run in Claude Code's own sandbox, which has not been proven on macOS yet.`;
