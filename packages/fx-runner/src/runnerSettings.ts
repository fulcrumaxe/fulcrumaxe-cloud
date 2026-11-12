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
import { parseBase } from "./verifyBrowser/pin.js";

/** Jobs held at once, light and heavy together, never exceed the light maximum (8). */
const MAX_TOTAL_CAPACITY = MAX_LIGHT_CAPACITY;

export const SETTINGS_FILE = "runner-settings.json";
export const PAUSE_FILE = "claiming.paused";
/** The drain marker (`fx-runner drain`): the daemon claims nothing while it exists, and exits 0 once the jobs in hand have ended. */
export const DRAIN_FILE = "claiming.drain";
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface RunnerSettings {
  /** Safety ceiling on jobs held at once (1..8). Never a target. */
  ceilingTotal: number;
  /** Safety ceiling on heavy jobs held at once (1..4). */
  ceilingHeavy: number;
  /** Memory kept free for the person's own work, in GB; absent: 25% of RAM, at least 2 GB. */
  reserveGb?: number;
  /** CPU cores kept free for the person's own work (whole cores, 0 allowed); absent: 20% of the cores (the 0.8 load-per-core threshold). Set by `cpu-reserve`. */
  cpuReserve?: number;
  /** True only when the person set `budget.heavy.memory`; otherwise the heavy memory budget is derived from the measured footprints (jobLimits.budgetsOf) and `budget.heavy.memoryGb` is not used. */
  heavyMemorySet?: true;
  /** The hard limits one job of each class runs under (D#6 C43-5): memory in whole GB and the most processes and threads it may hold. */
  budget: Record<JobClass, JobBudget>;
  /** D#749 V2b: the post-merge verify stage's local half. Present only when one of its two values is set. */
  verify?: VerifySettings;
}

/**
 * D#749 V2b. Both values are the machine owner's own, set here and nowhere else: no cloud message carries either.
 *  - `deployArgv`: the command that deploys a commit, as an argument vector (never a shell string): the program, then its arguments. A relative script among them is
 *    looked up inside the repository's checkout and checked by `deployOrder.ts`.
 *  - `deployDir`: the repository checkout on this machine the command runs in, an absolute path. The command's script is looked up below it and nowhere else.
 *  - `testAccount`: the label of the account the machine's Chrome must be signed in as for the browser job.
 */
export interface VerifySettings {
  deployArgv?: readonly string[];
  deployDir?: string;
  testAccount?: string;
  /** D#749 V2c-2b: the runner-owned Playwright browser. All three are the machine owner's; none of them lives in a repository. */
  browser?: BrowserSettings;
}

/**
 * D#749 V2c-2b. `executable`: the Chromium (or Chrome) the verify browser runs, an absolute path, never the person's running Chrome. `storageState`: the Playwright storage-state file `fx-runner verify-login`
 * wrote (default `~/.config/fx-runner/verify/storage-state.json`, mode 0600, inside the credential floor). `baseUrl`: the app under test, https (or loopback http).
 */
export interface BrowserSettings {
  executable?: string;
  storageState?: string;
  baseUrl?: string;
}

export const VERIFY_BROWSER_EXECUTABLE_KEY = "verify.browser.executable";
export const VERIFY_BROWSER_STORAGE_STATE_KEY = "verify.browser.storage_state";
export const VERIFY_BROWSER_BASE_URL_KEY = "verify.browser.base_url";
const BROWSER_KEYS = [VERIFY_BROWSER_EXECUTABLE_KEY, VERIFY_BROWSER_STORAGE_STATE_KEY, VERIFY_BROWSER_BASE_URL_KEY] as const;
/** The storage-state file of a runner that was not told another: under the credential floor's `.config/fx-runner`. */
export const DEFAULT_STORAGE_STATE = [".config", "fx-runner", "verify", "storage-state.json"] as const;
export const storageStateFor = (home: string, settings: BrowserSettings | undefined): string => settings?.storageState ?? path.join(home, ...DEFAULT_STORAGE_STATE);
/** A base URL as stored: https, or http on a loopback host (the same rule as the browser's origin pin), with no credentials, no query and no fragment, at most 200 characters. */
export function parseBaseUrlSetting(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) return undefined;
  const pin = parseBase(value);
  const u = pin === undefined ? undefined : new URL(pin.href);
  return pin === undefined || u === undefined || u.search !== "" || u.hash !== "" ? undefined : pin.href;
}

export const VERIFY_DEPLOY_ARGV_KEY = "verify.deploy_argv";
export const VERIFY_DEPLOY_DIR_KEY = "verify.deploy_dir";
export const VERIFY_TEST_ACCOUNT_KEY = "verify.test_account";
const VERIFY_KEYS = [VERIFY_DEPLOY_ARGV_KEY, VERIFY_DEPLOY_DIR_KEY, VERIFY_TEST_ACCOUNT_KEY, ...BROWSER_KEYS] as const;
/** Bounds on a deploy command: at most 32 words, each 1 to 500 characters with no control character (so no newline and no NUL). */
export const MAX_DEPLOY_ARGV_WORDS = 32;
const DEPLOY_WORD = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,500}$/u;
const TEST_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,99}$/;
/** A checkout path: absolute, already normalized (no `.`, `..`, doubled or trailing slash), plain printable characters, at most 1024. */
const isCheckoutPath = (value: unknown): value is string => typeof value === "string" && value.length <= 1024 && path.isAbsolute(value) && path.resolve(value) === value && /^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u.test(value);

/** The words of a deploy command, or undefined when the value is not an array of 1 to 32 plain strings. */
export function parseDeployArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DEPLOY_ARGV_WORDS) return undefined;
  return value.every((word) => typeof word === "string" && DEPLOY_WORD.test(word) && word.trim() !== "") ? (value as string[]).slice() : undefined;
}

export interface JobBudget {
  memoryGb: number;
  tasks: number;
}

/** Light gets 2 GB and 512 tasks, heavy 6 GB and 4096. The heavy memory figure is only what a runner shows when its person never set one: unless `heavyMemorySet`, the budget is derived from measured footprints (floor `HEAVY_AUTO_FLOOR_GB`). */
export const DEFAULT_BUDGET: Readonly<Record<JobClass, JobBudget>> = { light: { memoryGb: 2, tasks: 512 }, heavy: { memoryGb: 6, tasks: 4096 } };
export const BUDGET_MEMORY_GB: Readonly<Record<JobClass, readonly [number, number]>> = { light: [1, 8], heavy: [2, 32] };
/** The smallest heavy memory budget that is derived (not set): 1.5 times the learned heavy footprint, rounded up, never below this. */
export const HEAVY_AUTO_FLOOR_GB = 4;
export const BUDGET_TASKS: readonly [number, number] = [64, 65_536];

export const DEFAULT_SETTINGS: RunnerSettings = { ceilingTotal: MAX_TOTAL_CAPACITY, ceilingHeavy: MAX_HEAVY_CAPACITY, budget: DEFAULT_BUDGET };
const BUDGET_KEYS = ["budget.light.memory", "budget.light.tasks", "budget.heavy.memory", "budget.heavy.tasks"] as const;
export const SETTING_KEYS: readonly string[] = ["concurrency.total", "concurrency.heavy", "reserve-gb", "cpu-reserve", ...BUDGET_KEYS, ...VERIFY_KEYS];

const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  "concurrency.total": [1, MAX_TOTAL_CAPACITY],
  "concurrency.heavy": [1, MAX_HEAVY_CAPACITY],
  "reserve-gb": [1, 256],
  "cpu-reserve": [0, 256],
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
    const cores = whole(parsed["cpuReserve"], 0, 256);
    if (cores !== undefined) settings.cpuReserve = cores;
    const budget = parsed["budget"] as Record<string, Record<string, unknown> | undefined> | null | undefined;
    for (const cls of ["light", "heavy"] as const) {
      const saved = budget?.[cls];
      const memory = whole(saved?.["memoryGb"], ...BUDGET_MEMORY_GB[cls]);
      if (memory !== undefined) {
        settings.budget[cls].memoryGb = memory;
        if (cls === "heavy") settings.heavyMemorySet = true;
      }
      settings.budget[cls].tasks = whole(saved?.["tasks"], ...BUDGET_TASKS) ?? settings.budget[cls].tasks;
    }
    // A value that does not parse is absent, like every other field here: a damaged deploy command means no deploy, never a guessed one.
    const verify = parsed["verify"] as Record<string, unknown> | null | undefined;
    const argv = parseDeployArgv(verify?.["deployArgv"]);
    const account = typeof verify?.["testAccount"] === "string" && TEST_ACCOUNT.test(verify["testAccount"]) ? verify["testAccount"] : undefined;
    const dir = isCheckoutPath(verify?.["deployDir"]) ? verify["deployDir"] : undefined;
    const saved = verify?.["browser"] as Record<string, unknown> | null | undefined;
    const executable = isCheckoutPath(saved?.["executable"]) ? saved["executable"] : undefined;
    const storageState = isCheckoutPath(saved?.["storageState"]) ? saved["storageState"] : undefined;
    const baseUrl = parseBaseUrlSetting(saved?.["baseUrl"]);
    const browser: BrowserSettings = { ...(executable === undefined ? {} : { executable }), ...(storageState === undefined ? {} : { storageState }), ...(baseUrl === undefined ? {} : { baseUrl }) };
    if (argv !== undefined || dir !== undefined || account !== undefined || Object.keys(browser).length > 0) settings.verify = { ...(argv === undefined ? {} : { deployArgv: argv }), ...(dir === undefined ? {} : { deployDir: dir }), ...(account === undefined ? {} : { testAccount: account }), ...(Object.keys(browser).length > 0 ? { browser } : {}) };
  } catch {
    // fx-swallow-ok: a missing or damaged settings file is the defaults
  }
  return settings;
}

/** The file's text: the heavy memory figure is written only when the person set it, so a derived budget stays derived. */
function serialize(settings: RunnerSettings): string {
  const { heavyMemorySet, ...rest } = settings;
  const budget = { light: rest.budget.light, heavy: heavyMemorySet === true ? rest.budget.heavy : { tasks: rest.budget.heavy.tasks } };
  return `${JSON.stringify({ ...rest, budget })}\n`;
}

/** Saves one of the two verify values. The deploy command is given as a JSON array of strings; anything else is refused and nothing is written. */
function setVerify(stateDir: string, key: (typeof VERIFY_KEYS)[number], text: string): string {
  const settings = loadSettings(stateDir);
  const verify: VerifySettings = { ...settings.verify };
  if (key === VERIFY_DEPLOY_ARGV_KEY) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // fx-swallow-ok: the refusal below is the report; the text is not repeated
      parsed = undefined;
    }
    const argv = parseDeployArgv(parsed);
    if (argv === undefined) throw new CliError(`${key} takes a JSON array of 1 to ${MAX_DEPLOY_ARGV_WORDS} words, for example '["bash", ".autonomous-team/deploy-staging.sh"]'`, 2);
    verify.deployArgv = argv;
  } else if ((BROWSER_KEYS as readonly string[]).includes(key)) {
    const browser: BrowserSettings = { ...verify.browser };
    if (key === VERIFY_BROWSER_BASE_URL_KEY) {
      const url = parseBaseUrlSetting(text);
      if (url === undefined) throw new CliError(`${key} takes the app's address: https, or http on a loopback host, with no credentials, query or fragment`, 2);
      browser.baseUrl = url;
    } else {
      if (!isCheckoutPath(text)) throw new CliError(`${key} takes an absolute path, written plainly (no . or .. part, no trailing slash)`, 2);
      if (key === VERIFY_BROWSER_EXECUTABLE_KEY) browser.executable = text;
      else browser.storageState = text;
    }
    verify.browser = browser;
  } else if (key === VERIFY_DEPLOY_DIR_KEY) {
    if (!isCheckoutPath(text)) throw new CliError(`${key} takes the absolute path of a repository checkout on this machine, written plainly (no . or .. part, no trailing slash)`, 2);
    verify.deployDir = text;
  } else {
    if (!TEST_ACCOUNT.test(text)) throw new CliError(`${key} takes an account label of 1 to 100 letters, digits and . _ @ + -`, 2);
    verify.testAccount = text;
  }
  settings.verify = verify;
  writePrivateFile(stateDir, SETTINGS_FILE, serialize(settings));
  return `${key} set; it applies from the next claim`;
}

/** Validates and saves one setting. A value out of range or not a whole number is refused with a message and nothing is written. */
export function setSetting(stateDir: string, key: string, text: string): string {
  if ((VERIFY_KEYS as readonly string[]).includes(key)) return setVerify(stateDir, key as (typeof VERIFY_KEYS)[number], text);
  const range = RANGES[key];
  if (range === undefined) throw new CliError(`unknown setting ${key.slice(0, 40)}`, 2);
  if ((key === "reserve-gb" || key === "cpu-reserve") && text === "auto") return unsetSetting(stateDir, key);
  const target = budgetKey(key);
  // A memory budget may be written with its unit (6, 6G or 6GB); every other value is a plain whole number.
  const value = text.match(target?.field === "memoryGb" ? /^(\d{1,4})(?:GB?)?$/i : /^(\d{1,5})$/)?.[1];
  const number = value === undefined ? undefined : Number(value);
  if (number === undefined || number < range[0] || number > range[1]) throw new CliError(`${key} takes a whole number${target?.field === "memoryGb" ? " of GB" : ""} from ${range[0]} to ${range[1]}`, 2);
  const settings = loadSettings(stateDir);
  if (target !== undefined) {
    settings.budget[target.cls][target.field] = number;
    if (key === "budget.heavy.memory") settings.heavyMemorySet = true;
  } else if (key === "cpu-reserve") settings.cpuReserve = number;
  else if (key === "concurrency.total") settings.ceilingTotal = number;
  else if (key === "concurrency.heavy") settings.ceilingHeavy = number;
  else settings.reserveGb = number;
  writePrivateFile(stateDir, SETTINGS_FILE, serialize(settings));
  return `${key} set to ${number}; it applies from the next claim`;
}

/** Returns one setting to its automatic default (the ceilings to their maxima, the reserve to 25% of RAM with a 2 GB minimum, the CPU reserve to 20% of the cores, the heavy memory budget to the one derived from measured footprints). */
export function unsetSetting(stateDir: string, key: string): string {
  if (RANGES[key] === undefined && !(VERIFY_KEYS as readonly string[]).includes(key)) throw new CliError(`unknown setting ${key.slice(0, 40)}`, 2);
  const target = budgetKey(key);
  const settings = loadSettings(stateDir);
  if ((VERIFY_KEYS as readonly string[]).includes(key)) {
    const left: VerifySettings = { ...settings.verify };
    if (key === VERIFY_DEPLOY_ARGV_KEY) delete left.deployArgv;
    else if (key === VERIFY_DEPLOY_DIR_KEY) delete left.deployDir;
    else if (key === VERIFY_TEST_ACCOUNT_KEY) delete left.testAccount;
    else {
      const browser: BrowserSettings = { ...left.browser };
      if (key === VERIFY_BROWSER_EXECUTABLE_KEY) delete browser.executable;
      else if (key === VERIFY_BROWSER_STORAGE_STATE_KEY) delete browser.storageState;
      else delete browser.baseUrl;
      if (Object.keys(browser).length === 0) delete left.browser;
      else left.browser = browser;
    }
    if (left.deployArgv === undefined && left.deployDir === undefined && left.testAccount === undefined && left.browser === undefined) delete settings.verify;
    else settings.verify = left;
    writePrivateFile(stateDir, SETTINGS_FILE, serialize(settings));
    return `${key} is cleared; it applies from the next claim`;
  } else if (key === "concurrency.total") settings.ceilingTotal = DEFAULT_SETTINGS.ceilingTotal;
  else if (key === "concurrency.heavy") settings.ceilingHeavy = DEFAULT_SETTINGS.ceilingHeavy;
  else if (target !== undefined) {
    settings.budget[target.cls][target.field] = DEFAULT_BUDGET[target.cls][target.field];
    if (key === "budget.heavy.memory") delete settings.heavyMemorySet;
  } else if (key === "cpu-reserve") delete settings.cpuReserve;
  else delete settings.reserveGb;
  writePrivateFile(stateDir, SETTINGS_FILE, serialize(settings));
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

/** The pid in the daemon's ledger lock (`<ledgerFile>.lock`), or undefined when there is no lock or it holds none: no daemon holds this state directory. */
export function daemonPid(stateDir: string, ledgerFile: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path.join(stateDir, `${ledgerFile}.lock`), "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    // fx-swallow-ok: no readable lock means no daemon holds this state directory
    return undefined;
  }
}

/** Whether `fx-runner drain` asked the daemon to finish what it holds and exit. Only whether the marker exists is looked at. */
export function isDraining(stateDir: string): boolean {
  try {
    lstatSync(path.join(stateDir, DRAIN_FILE));
    return true;
  } catch {
    // fx-swallow-ok: no marker file is "not draining"
    return false;
  }
}

export function setDraining(stateDir: string, draining: boolean): void {
  if (draining) writePrivateFile(stateDir, DRAIN_FILE, "drain\n");
  else rmSync(path.join(stateDir, DRAIN_FILE), { force: true });
}
