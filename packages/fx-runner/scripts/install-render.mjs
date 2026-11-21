// The one renderer of install.sh (and of the Homebrew formula), D#845 ON-4a. Dependency-free on purpose: it imports nothing, so the
// release CLI (scripts/release-render.mjs) and the cloud's install route both load exactly this file, and the two rendered copies of the
// script cannot differ in how a placeholder is filled.
//
// Placeholders: @FX_VERSION@, @FX_SHA256_<PLATFORM>@, @FX_SIZE_<PLATFORM>@, @FX_FILE_<PLATFORM>@, and, when the caller passes them,
// @FX_TARGET_BASE_URL@ and @FX_TRUSTED_ROOT_SHA256@. A value that is not what its placeholder stands for is refused, and so is any
// `@FX_` that is still in the text afterwards, so nothing can be written into a shell script that was not checked first.

/** The platforms a release ships, and the file name each one has on the release page. The order is the order of the manifest. */
export const ARTIFACT_NAMES = Object.freeze({
  "darwin-arm64": "fx-runner-darwin-arm64",
  "darwin-x64": "fx-runner-darwin-x64",
  "linux-x64": "fx-runner-linux-x64",
  "linux-arm64": "fx-runner-linux-arm64",
});

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
// https only, a plain host (and port), a plain path, a trailing slash; no user info, query, fragment, quote, `$`, backtick, backslash or space.
const BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+-]+)*\/$/;

const upper = (platform) => platform.toUpperCase().replace(/-/g, "_");

/**
 * Fills the placeholders of `text`. `manifest` is `{ version, entries: [{ platform, sha256, size }] }`; `options` may carry `targetBaseUrl`
 * (an https base ending in `/`, to which `v<version>/<file>` is appended) and `trustedRootSha256`. Throws if a value is malformed or any
 * `@FX_` is left.
 * @param {string} text
 * @param {{ version: string, entries: Array<{ platform: string, sha256: string, size?: number }> }} manifest
 * @param {{ targetBaseUrl?: string, trustedRootSha256?: string }} [options]
 * @returns {string}
 */
export function renderTemplate(text, manifest, options = {}) {
  if (!VERSION.test(String(manifest.version))) throw new Error("the version is not x.y.z");
  let out = text.replaceAll("@FX_VERSION@", () => manifest.version);
  for (const entry of manifest.entries) {
    if (!Object.hasOwn(ARTIFACT_NAMES, entry.platform)) throw new Error("the manifest names a platform that is not released");
    if (!HEX64.test(String(entry.sha256))) throw new Error(`the ${entry.platform} entry has no SHA-256`);
    const name = ARTIFACT_NAMES[entry.platform];
    out = out.replaceAll(`@FX_SHA256_${upper(entry.platform)}@`, () => entry.sha256).replaceAll(`@FX_FILE_${upper(entry.platform)}@`, () => name);
    if (entry.size !== undefined) {
      if (!Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error(`the ${entry.platform} entry has no usable size`);
      out = out.replaceAll(`@FX_SIZE_${upper(entry.platform)}@`, () => String(entry.size));
    }
  }
  if (options.targetBaseUrl !== undefined) {
    if (!BASE_URL.test(options.targetBaseUrl)) throw new Error("the target base URL must be a plain https address that ends in /");
    out = out.replaceAll("@FX_TARGET_BASE_URL@", () => options.targetBaseUrl);
  }
  if (options.trustedRootSha256 !== undefined) {
    if (!HEX64.test(options.trustedRootSha256)) throw new Error("the trusted root hash is not a SHA-256");
    out = out.replaceAll("@FX_TRUSTED_ROOT_SHA256@", () => options.trustedRootSha256);
  }
  const left = out.match(/@FX_[A-Z0-9_]*@?/g);
  if (left !== null) throw new Error(`placeholders left after rendering: ${[...new Set(left)].join(", ")}`);
  return out;
}
