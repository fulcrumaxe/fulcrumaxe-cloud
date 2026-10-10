/**
 * The runner's own concurrency settings and its claiming pause (D#6 C43-4), both small files in the state directory. They are read again before
 * every claim, so a change applies from the next claim and a running job is never touched. Files are written 0600 through a temporary file and a
 * rename; a file that is not a plain file, or is damaged, counts as absent.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { MAX_HEAVY_CAPACITY, MAX_LIGHT_CAPACITY } from "@fulcrumaxe/runner-protocol";
import { CliError } from "./cliError.js";
import { writePrivateFile } from "./config.js";

/** Jobs held at once, light and heavy together, never exceed the light maximum (8). */
const MAX_TOTAL_CAPACITY = MAX_LIGHT_CAPACITY;

export const SETTINGS_FILE = "runner-settings.json";
export const PAUSE_FILE = "claiming.paused";
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface RunnerSettings {
  /** Safety ceiling on jobs held at once (1..8). Never a target. */
  ceilingTotal: number;
  /** Safety ceiling on heavy jobs held at once (1..4). */
  ceilingHeavy: number;
  /** Memory kept free for the person's own work, in GB; absent: 25% of RAM, at least 2 GB. */
  reserveGb?: number;
}

export const DEFAULT_SETTINGS: RunnerSettings = { ceilingTotal: MAX_TOTAL_CAPACITY, ceilingHeavy: MAX_HEAVY_CAPACITY };
export const SETTING_KEYS: readonly string[] = ["concurrency.total", "concurrency.heavy", "reserve-gb"];

const RANGES: Readonly<Record<string, readonly [number, number]>> = { "concurrency.total": [1, MAX_TOTAL_CAPACITY], "concurrency.heavy": [1, MAX_HEAVY_CAPACITY], "reserve-gb": [1, 256] };

const whole = (value: unknown, min: number, max: number): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined);

export function loadSettings(stateDir: string): RunnerSettings {
  const settings: RunnerSettings = { ...DEFAULT_SETTINGS };
  try {
    const file = path.join(stateDir, SETTINGS_FILE);
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return settings;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    settings.ceilingTotal = whole(parsed["ceilingTotal"], 1, MAX_TOTAL_CAPACITY) ?? settings.ceilingTotal;
    settings.ceilingHeavy = whole(parsed["ceilingHeavy"], 1, MAX_HEAVY_CAPACITY) ?? settings.ceilingHeavy;
    const reserve = whole(parsed["reserveGb"], 1, 256);
    if (reserve !== undefined) settings.reserveGb = reserve;
  } catch {
    // fx-swallow-ok: a missing or damaged settings file is the defaults
  }
  return settings;
}

/** Validates and saves one setting. A value out of range or not a whole number is refused with a message and nothing is written. */
export function setSetting(stateDir: string, key: string, text: string): string {
  const range = RANGES[key];
  if (range === undefined) throw new CliError(`unknown setting ${key.slice(0, 40)}`, 2);
  if (key === "reserve-gb" && text === "auto") return unsetSetting(stateDir, key);
  const value = /^\d{1,4}$/.test(text) ? Number(text) : undefined;
  if (value === undefined || value < range[0] || value > range[1]) throw new CliError(`${key} takes a whole number from ${range[0]} to ${range[1]}`, 2);
  const settings = loadSettings(stateDir);
  if (key === "concurrency.total") settings.ceilingTotal = value;
  else if (key === "concurrency.heavy") settings.ceilingHeavy = value;
  else settings.reserveGb = value;
  writePrivateFile(stateDir, SETTINGS_FILE, `${JSON.stringify(settings)}\n`);
  return `${key} set to ${value}; it applies from the next claim`;
}

/** Returns one setting to its automatic default (the ceilings to their maxima, the reserve to 25% of RAM with a 2 GB minimum). */
export function unsetSetting(stateDir: string, key: string): string {
  if (RANGES[key] === undefined) throw new CliError(`unknown setting ${key.slice(0, 40)}`, 2);
  const settings = loadSettings(stateDir);
  if (key === "concurrency.total") settings.ceilingTotal = DEFAULT_SETTINGS.ceilingTotal;
  else if (key === "concurrency.heavy") settings.ceilingHeavy = DEFAULT_SETTINGS.ceilingHeavy;
  else delete settings.reserveGb;
  writePrivateFile(stateDir, SETTINGS_FILE, `${JSON.stringify(settings)}\n`);
  return `${key} is back to automatic; it applies from the next claim`;
}

/** Whether claiming is paused by the person. Looks only at whether the marker exists (no content is read, no link is followed). */
export function isPaused(stateDir: string): boolean {
  try {
    lstatSync(path.join(stateDir, PAUSE_FILE));
    return true;
  } catch {
    // fx-swallow-ok: no marker file is "not paused"
    return false;
  }
}

export function setPaused(stateDir: string, paused: boolean): void {
  if (paused) writePrivateFile(stateDir, PAUSE_FILE, "paused\n");
  else rmSync(path.join(stateDir, PAUSE_FILE), { force: true });
}
