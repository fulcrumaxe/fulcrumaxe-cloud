/**
 * Names and limits shared by the runner and the Playwright config. No browser driver is imported here: `plan`
 * and `run` load this module, and `plan` must never start (or even load) a browser.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_WORKERS = 4;
export const DEFAULT_WORKERS = 2;
export const TARGET_ENV_NAME = "LIVE_E2E_TARGET";
export const WORKERS_ENV_NAME = "LIVE_E2E_WORKERS";
export const OUTPUT_DIR_ENV_NAME = "LIVE_E2E_OUTPUT_DIR";

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** An unset, empty or non-numeric value gives the default; anything else is clamped to 1..MAX_WORKERS. */
export function resolveWorkers(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return DEFAULT_WORKERS;
  return Math.min(MAX_WORKERS, Math.max(1, Math.floor(n)));
}
