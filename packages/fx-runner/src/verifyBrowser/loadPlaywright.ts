import path from "node:path";

/**
 * D#749 V2c-2b: where the Playwright library comes from. It cannot be bundled into the single-file program (it loads its browser-protocol packages by path), so the release build leaves it OUT
 * of the bundle (scripts/build-sea.mjs marks it external) and the executable loads it from a sidecar folder laid down next to the binary:
 *
 *     <folder of the binary>/fx-runner-playwright/node_modules/playwright-core
 *
 * Nothing under src/ loads a module by a computed route (test/publicBoundary.test.ts), so the one place that can, `bin/fx-runner.mjs`, builds the loader (a `require` anchored in the sidecar
 * folder, or at the program's own address when run from source) and hands it over with `setPlaywrightLoader`. A program started any other way has no loader: the library is "not available",
 * the capability is never advertised and a verify browser job ends with the closed code `playwright_missing`. Tests that drive a real browser install a loader of their own.
 */
export const SIDECAR_DIR = "fx-runner-playwright";

export interface PlaywrightLoader {
  /** The library (the caller, the browser driver, gives it its type), or throws. */
  load(): Promise<unknown>;
  /** Whether `load` can find it now (a lookup that loads nothing). */
  available(): boolean;
}

let loader: PlaywrightLoader | undefined;

/** Set once at start-up by the program's entry. */
export function setPlaywrightLoader(next: PlaywrightLoader | undefined): void {
  loader = next;
}

/** The sidecar folder for a single executable at `execPath`. */
export const sidecarFor = (execPath: string): string => path.join(path.dirname(execPath), SIDECAR_DIR);

/** Whether the library can be loaded now. The daemon asks this before it advertises the capability (playwrightProbe.ts). */
export function playwrightAvailable(): boolean {
  return loader?.available() ?? false;
}

/** The Playwright library, or throws (the caller turns that into the closed code `playwright_missing`). */
export async function loadPlaywright(): Promise<unknown> {
  if (loader === undefined) throw new Error("playwright_missing");
  return loader.load();
}
