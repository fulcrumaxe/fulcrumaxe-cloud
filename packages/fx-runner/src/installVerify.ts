/**
 * The narrow door the cloud's install route uses (`@fulcrumaxe/fx-runner/install-verify`, D#845 ON-4a). It exposes the runner's own TUF client and
 * build trust, the shared release selection, and the one renderer of install.sh, and nothing else, so the route never imports the package root
 * (which would pull the whole runner into a web function). Nothing here reads a file: the root and the template are compiled in.
 */
import { ARTIFACT_NAMES, renderTemplate } from "../scripts/install-render.mjs";
import { INSTALL_TEMPLATE_TEXT } from "../scripts/install-template.generated.mjs";

export { TUF_BUILD, type TufBuildConfig } from "./update/buildConfig.js";
export { newestRelease } from "./update/release.js";
export { TRUSTED_ROOT_SHA256 } from "./update/trustedRoot.js";
export { TufClient, type TargetInfoOutcome } from "./update/tuf.js";

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
