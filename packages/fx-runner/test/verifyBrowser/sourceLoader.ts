import { createRequire } from "node:module";
import { setPlaywrightLoader } from "../../src/verifyBrowser/loadPlaywright.js";

/** The loader `bin/fx-runner.mjs` installs, for a test that drives a real browser in this process: Node's own lookup from this file finds the library the package declares. */
export function useSourcePlaywright(): void {
  const require = createRequire(import.meta.url);
  setPlaywrightLoader({ load: async () => require("playwright-core"), available: () => true });
}
