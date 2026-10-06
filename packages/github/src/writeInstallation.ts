/**
 * D#2 H13e (D#31 C23 ruling 4): the one predicate that says whether an
 * installation may back a run, a PR, a merge or a Discussion write. Only the
 * `team` App may. Every other value -- `team_readonly`, `sitekit`, `null`,
 * `undefined`, and any near-miss spelling -- is refused, fail closed. The
 * comparison is strict equality: no trimming, no case folding.
 *
 * `getInstallationToken` calls this for the `run` purpose, and H14c-3 calls
 * it at dispatch time.
 */
export class InstallationNotWritableError extends Error {
  readonly code = "installation_not_writable";
  constructor() {
    super("installation_not_writable");
    this.name = "InstallationNotWritableError";
  }
}

export function assertWriteInstallation(appKind: unknown): asserts appKind is "team" {
  if (appKind !== "team") throw new InstallationNotWritableError();
}
