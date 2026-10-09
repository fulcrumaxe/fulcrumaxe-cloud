/**
 * What this build trusts for runner updates (D#6 R6-2a, correction C38 section 2).
 *
 * All three values are build-time constants. Nothing read at run time (no file, environment variable or flag) can supply or replace
 * one, and `tuf.ts` consults this constant and nothing else outside tests. They stay `undefined` until the release keys exist
 * (R6-W): `root` is the text of the first `root.json`, and the two base URLs are the release repository's metadata and target
 * locations. While any is missing, updates are "not configured in this build": the updater is off and makes no network call.
 */
export interface TufBuildConfig {
  /** The trusted root metadata (the text of `root.json`), signed offline by the owner's root keys. */
  readonly root: string | undefined;
  /** Where the consistent-snapshot metadata is served from (`https:` only). */
  readonly metadataBaseUrl: string | undefined;
  /** Where the release targets are served from (`https:` only); a target path is appended to it. */
  readonly targetBaseUrl: string | undefined;
}

export const TUF_BUILD: TufBuildConfig = Object.freeze({
  root: undefined,
  metadataBaseUrl: undefined,
  targetBaseUrl: undefined,
});
