/**
 * The narrow door the cloud's install route uses (`@fulcrumaxe/release-verify`, D#845 ON-4a). It exposes the one TUF client and
 * build trust, the shared release selection, and the one renderer of install.sh, and nothing else, so the route never needs the local runner
 * (the web app must never import it, D#6). Nothing here reads a file: the root and the template are compiled in.
 */
import { ARTIFACT_NAMES, renderTemplate } from "./install-render.mjs";
import { INSTALL_TEMPLATE_TEXT } from "./install-template.generated.mjs";

export { TUF_BUILD, type TufBuildConfig } from "./buildConfig.js";
export { newestRelease } from "./release.js";
export { TRUSTED_ROOT_SHA256 } from "./trustedRoot.js";
export { TufClient, type TargetInfoOutcome } from "./tuf.js";

/** The platforms a release ships, in manifest order. */
export const INSTALL_PLATFORMS: readonly string[] = Object.keys(ARTIFACT_NAMES);

export interface InstallRelease {
  version: string;
  /** What the verified metadata says about each platform's file. */
  entries: ReadonlyArray<{ platform: string; sha256: string; size: number }>;
  /** An https address ending in `/`; the script downloads `v<version>/<file>` from it. */
  targetBaseUrl: string;
  /** SHA-256 of the root the verifying client trusted. Named in a comment of the script for audit; the script does not check it. */
  trustedRootSha256: string;
}

/** The text of install.sh with this release's values in it. Throws on any value that is not what its placeholder stands for. */
export function renderInstallScript(release: InstallRelease): string {
  return renderTemplate(INSTALL_TEMPLATE_TEXT, { version: release.version, entries: [...release.entries] }, { targetBaseUrl: release.targetBaseUrl, trustedRootSha256: release.trustedRootSha256 }) as string;
}
