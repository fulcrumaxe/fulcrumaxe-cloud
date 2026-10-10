/**
 * The runner's own concurrency settings and its claiming pause (D#6 C43-4), both small files in the state directory. They are read again before
 * every claim, so a change applies from the next claim and a running job is never touched. Files are written 0600 through a temporary file and a
 * rename; a file that is not a plain file, or is damaged, counts as absent.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { MAX_HEAVY_CAPACITY, MAX_LIGHT_CAPACITY, type JobClass } from "@fulcrumaxe/runner-protocol";
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
  /** The hard limits one job of each class runs under (D#6 C43-5): memory in whole GB and the most processes and threads it may hold. */
  budget: Record<JobClass, JobBudget>;
}

export interface JobBudget {
  memoryGb: number;
  tasks: number;
}

/** Light gets 2 GB and 512 tasks, heavy 6 GB and 4096. */
export const DEFAULT_BUDGET: Readonly<Record<JobClass, JobBudget>> = { light: { memoryGb: 2, tasks: 512 }, heavy: { memoryGb: 6, tasks: 4096 } };
export const BUDGET_MEMORY_GB: Readonly<Record<JobClass, readonly [number, number]>> = { light: [1, 8], heavy: [2, 32] };
export const BUDGET_TASKS: readonly [number, number] = [64, 65_536];

export const DEFAULT_SETTINGS: RunnerSettings = { ceilingTotal: MAX_TOTAL_CAPACITY, ceilingHeavy: MAX_HEAVY_CAPACITY, budget: DEFAULT_BUDGET };
const BUDGET_KEYS = ["budget.light.memory", "budget.light.tasks", "budget.heavy.memory", "budget.heavy.tasks"] as const;
export const SETTING_KEYS: readonly string[] = ["concurrency.total", "concurrency.heavy", "reserve-gb", ...BUDGET_KEYS];

const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  "concurrency.total": [1, MAX_TOTAL_CAPACITY],
  "concurrency.heavy": [1, MAX_HEAVY_CAPACITY],
  "reserve-gb": [1, 256],
  "budget.light.memory": BUDGET_MEMORY_GB.light,
  "budget.light.tasks": BUDGET_TASKS,
  "budget.heavy.memory": BUDGET_MEMORY_GB.heavy,
  "budget.heavy.tasks": BUDGET_TASKS,
};

const budgetKey = (key: string): { cls: JobClass; field: "memoryGb" | "tasks" } | undefined => {
  const match = key.match(/^budget\.(light|heavy)\.(memory|tasks)$/);
  return match === null ? undefined : { cls: match[1] as JobClass, field: match[2] === "memory" ? "memoryGb" : "tasks" };
};

const whole = (value: unknown, min: number, max: number): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined);

export function loadSettings(stateDir: string): RunnerSettings {
  const settings: RunnerSettings = { ...DEFAULT_SETTINGS, budget: { light: { ...DEFAULT_BUDGET.light }, heavy: { ...DEFAULT_BUDGET.heavy } } };
  try {
    const file = path.join(stateDir, SETTINGS_FILE);
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return settings;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    settings.ceilingTotal = whole(parsed["ceilingTotal"], 1, MAX_TOTAL_CAPACITY) ?? settings.ceilingTotal;
    settings.ceilingHeavy = whole(parsed["ceilingHeavy"], 1, MAX_HEAVY_CAPACITY) ?? settings.ceilingHeavy;
    const reserve = whole(parsed["reserveGb"], 1, 256);
    if (reserve !== undefined) settings.reserveGb = reserve;
    const budget = parsed["budget"] as Record<string, Record<string, unknown> | undefined> | null | undefined;
    for (const cls of ["light", "heavy"] as const) {
      const saved = budget?.[cls];
      settings.budget[cls].memoryGb = whole(saved?.["memoryGb"], ...BUDGET_MEMORY_GB[cls]) ?? settings.budget[cls].memoryGb;
      settings.budget[cls].tasks = whole(saved?.["tasks"], ...BUDGET_TASKS) ?? settings.budget[cls].tasks;
    }
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
  const target = budgetKey(key);
  // A memory budget may be written with its unit (6, 6G or 6GB); every other value is a plain whole number.
  const value = text.match(target?.field === "memoryGb" ? /^(\d{1,4})(?:GB?)?$/i : /^(\d{1,5})$/)?.[1];
  const number = value === undefined ? undefined : Number(value);
  if (number === undefined || number < range[0] || number > range[1]) throw new CliError(`${key} takes a whole number${target?.field === "memoryGb" ? " of GB" : ""} from ${range[0]} to ${range[1]}`, 2);
  const settings = loadSettings(stateDir);
  if (target !== undefined) settings.budget[target.cls][target.field] = number;
  else if (key === "concurrency.total") settings.ceilingTotal = number;
  else if (key === "concurrency.heavy") settings.ceilingHeavy = number;
  else settings.reserveGb = number;
  writePrivateFile(stateDir, SETTINGS_FILE, `${JSON.stringify(settings)}\n`);
  return `${key} set to ${number}; it applies from the next claim`;
}

/** Returns one setting to its automatic default (the ceilings to their maxima, the reserve to 25% of RAM with a 2 GB minimum). */
export function unsetSetting(stateDir: string, key: string): string {
  if (RANGES[key] === undefined) throw new CliError(`unknown setting ${key.slice(0, 40)}`, 2);
  const target = budgetKey(key);
  const settings = loadSettings(stateDir);
  if (key === "concurrency.total") settings.ceilingTotal = DEFAULT_SETTINGS.ceilingTotal;
  else if (key === "concurrency.heavy") settings.ceilingHeavy = DEFAULT_SETTINGS.ceilingHeavy;
  else if (target !== undefined) settings.budget[target.cls][target.field] = DEFAULT_BUDGET[target.cls][target.field];
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
