// The version line `fx-runner --version` prints. The release build (scripts/build-sea.mjs) defines __FX_BUILD_EPOCH__ from SOURCE_DATE_EPOCH, so a
// release says the day it was built and two builds of one commit with one epoch say the same. A run from source has no epoch and says "from source".
import pkg from "../package.json";

declare const __FX_BUILD_EPOCH__: string | undefined;

export const RUNNER_VERSION: string = pkg.version;

export function versionLine(): string {
  const epoch = typeof __FX_BUILD_EPOCH__ === "string" ? Number(__FX_BUILD_EPOCH__) : Number.NaN;
  const built = Number.isSafeInteger(epoch) && epoch >= 0 ? new Date(epoch * 1000).toISOString().slice(0, 10) : "from source";
  return `fx-runner ${RUNNER_VERSION} (${built})`;
}
