/**
 * The runner's state directory (`~/.fx-runner`, mode 0700) and the two files `register` leaves in it: the private key
 * (see keys.ts) and `registration.json`, which holds no secret. Every file is written 0600 through a temporary file and
 * a rename, and read back only when it is a plain file nobody else can read. Runner state never lives in a workspace.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CREDENTIAL_MODES, type CredentialMode } from "@fulcrumaxe/runner-protocol";
import { CliError } from "./cliError.js";
import { normaliseOrigin } from "./cloud.js";

export const STATE_DIR_NAME = ".fx-runner";
export const REGISTRATION_FILE = "registration.json";
export const KEY_FILE = "runner-key.pem";
/** The cloud refuses a runner key older than this (90 days) and asks for a new registration. */
export const KEY_MAX_AGE_DAYS = 90;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

export interface Registration {
  version: 1;
  /** `scheme://host[:port]` the runner registered with. */
  cloud_origin: string;
  runner_id: string;
  /** What the user said at registration. The cloud's response does not repeat it, so it is recorded, not verified. */
  credential_mode: CredentialMode;
  /** RFC 7638 thumbprint of the public key: the id every signed request carries. */
  jkt: string;
  registered_at: string;
}

/** The state directory: `override` when the caller gave one, else `<home>/.fx-runner`. */
export function stateDirFor(home: string | undefined, override: string | undefined): string {
  if (override) return path.resolve(override);
  if (!home || !path.isAbsolute(home)) throw new CliError("cannot find your home directory; set FX_RUNNER_HOME to the state directory");
  return path.join(home, STATE_DIR_NAME);
}

/** Creates the state directory (0700) if needed and tightens it if it exists wider. A link or a non-directory is refused. */
export function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new CliError("the runner state path is not a plain directory");
  if ((info.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** Writes `text` to `dir/name` with mode 0600, replacing any earlier file in one rename. */
export function writePrivateFile(dir: string, name: string, text: string): void {
  ensureStateDir(dir);
  const target = path.join(dir, name);
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The text of `dir/name`, or undefined when it does not exist. A link, a non-file or a file others can read is refused. */
export function readPrivateFile(dir: string, name: string): string | undefined {
  const target = path.join(dir, name);
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw new CliError(`cannot read ${target}`);
  }
  if (!info.isFile()) throw new CliError(`${target} is not a plain file`);
  if ((info.mode & 0o077) !== 0) throw new CliError(`${target} can be read by other users; run: chmod 600 ${target}`);
  return readFileSync(target, "utf8");
}

/** A lock older than this was left by a run that died; two minutes is far beyond one request's 15-second timeout. */
const LOCK_STALE_MS = 120_000;
const LOCK_FILE = "register.lock";

/** Runs `fn` while holding `dir/register.lock`, so two `register` runs cannot both pass the "no registration yet" check. */
export async function withRegisterLock<T>(dir: string, now: () => Date, fn: () => Promise<T>): Promise<T> {
  ensureStateDir(dir);
  const target = path.join(dir, LOCK_FILE);
  const take = (): void => {
    closeSync(openSync(target, "wx", 0o600));
  };
  try {
    take();
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw new CliError(`cannot lock ${dir}`);
    let age = 0;
    try {
      age = now().getTime() - lstatSync(target).mtimeMs;
    } catch {
      // fx-swallow-ok: the lock vanished between the two calls; taking it again below decides
    }
    if (age <= LOCK_STALE_MS) throw new CliError("another fx-runner register is running on this machine; wait for it to finish");
    rmSync(target, { force: true });
    try {
      take();
    } catch {
      throw new CliError("another fx-runner register is running on this machine; wait for it to finish");
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(target, { force: true });
  }
}

export function removeStateFile(dir: string, name: string): void {
  rmSync(path.join(dir, name), { force: true });
}

function isRegistration(value: unknown): value is Registration {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).length === 6 &&
    r.version === 1 &&
    typeof r.cloud_origin === "string" &&
    typeof r.runner_id === "string" && UUID.test(r.runner_id) &&
    typeof r.credential_mode === "string" && (CREDENTIAL_MODES as readonly string[]).includes(r.credential_mode) &&
    typeof r.jkt === "string" && THUMBPRINT.test(r.jkt) &&
    typeof r.registered_at === "string" && !Number.isNaN(Date.parse(r.registered_at))
  );
}

/** The saved registration, or undefined when this machine has none. A damaged file is an error, never "not registered". */
export function loadRegistration(dir: string): Registration | undefined {
  const text = readPrivateFile(dir, REGISTRATION_FILE);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${path.join(dir, REGISTRATION_FILE)} is damaged; run: fx-runner revoke --local, then register again`);
  }
  if (!isRegistration(parsed)) throw new CliError(`${path.join(dir, REGISTRATION_FILE)} is damaged; run: fx-runner revoke --local, then register again`);
  // The origin is what every later signed request goes to: it gets the same check as the flag did.
  try {
    normaliseOrigin(parsed.cloud_origin);
  } catch {
    throw new CliError(`${path.join(dir, REGISTRATION_FILE)} is damaged; run: fx-runner revoke --local, then register again`);
  }
  return parsed;
}

export function saveRegistration(dir: string, registration: Registration): void {
  writePrivateFile(dir, REGISTRATION_FILE, `${JSON.stringify(registration, null, 2)}\n`);
}
