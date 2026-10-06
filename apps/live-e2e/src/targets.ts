/**
 * Targets and the production guard, layer 1 (code, not config).
 *
 * A target file is `targets/<name>.json`: the NAMES of the env variables that hold the exact origin and the
 * expected Vercel project id (`origin_env`, `project_id_env`; the values are deployment specific and are never
 * committed), whether it is protected, the NAMES of the env values it reads and its budget. The loader resolves
 * the two variables when the target is selected and fails closed, naming the variable, when one is unset or
 * empty; there is no default host. The schema is closed and carries no
 * destructive switch of any kind: the loader rejects every key outside it, so adding `allow_destructive`
 * (or anything else) to `production.json` fails the load, naming the key.
 *
 * Layer 1 (`targetGuard`) refuses, on the production target, any pack that is destructive or does not list
 * production. Nothing in a target file or a flag lifts it; there is no `--force`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TARGET_NAMES, type Pack, type TargetName } from "./manifest.js";

export interface Target {
  name: TargetName;
  /** Exact origin, https only: the only thing a request's origin is ever compared against. */
  origin: string;
  /** The expected Vercel project id (not a secret). Layer 2 (T5) compares it with the deployment's own. */
  project_id: string;
  /** Whether the deployment sits behind Vercel Deployment Protection. */
  protected: boolean;
  /** Names (never values) of the env variables this target's runs read. */
  env: string[];
  budget_usd: { default: number; max: number };
}

const TARGET_KEYS = ["name", "origin_env", "project_id_env", "protected", "env", "budget_usd"] as const;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export type EnvSource = Record<string, string | undefined>;
const BUDGET_KEYS = ["default", "max"] as const;

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict parse of one target file's JSON. Throws TargetError naming the file and the problem. */
export function parseTarget(raw: unknown, name: string, envSource: EnvSource = process.env): Target {
  const errors: string[] = [];
  const bad = (msg: string): void => {
    errors.push(`target ${name}: ${msg}`);
  };
  if (!isObject(raw)) throw new TargetError(`target ${name}: file must be a JSON object`);
  for (const key of Object.keys(raw)) {
    if (!(TARGET_KEYS as readonly string[]).includes(key)) bad(`unknown key "${key}"`);
  }
  for (const key of TARGET_KEYS) {
    if (!(key in raw)) bad(`missing key "${key}"`);
  }
  if (raw.name !== name) bad(`"name" must equal "${name}"`);
  const resolveEnv = (key: "origin_env" | "project_id_env"): string | undefined => {
    const varName = raw[key];
    if (typeof varName !== "string" || !ENV_NAME.test(varName)) {
      bad(`"${key}" must be an environment variable NAME`);
      return undefined;
    }
    const value = envSource[varName];
    if (value === undefined || value.trim() === "") {
      bad(`environment variable ${varName} (${key}) is not set; set it to select this target (there is no default)`);
      return undefined;
    }
    return value;
  };
  const origin = resolveEnv("origin_env");
  if (origin !== undefined) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = u.protocol === "https:" && u.origin === origin;
    } catch {
      ok = false;
    }
    if (!ok) bad(`"origin_env" (${String(raw.origin_env)}) must hold an exact https origin (scheme, host, optional port; no path or trailing slash)`);
  }
  const projectId = resolveEnv("project_id_env");
  if (projectId !== undefined && !/^prj_[A-Za-z0-9]+$/.test(projectId)) bad(`"project_id_env" (${String(raw.project_id_env)}) must hold a value like prj_...`);
  if (typeof raw.protected !== "boolean") bad(`"protected" must be a boolean`);
  if (!Array.isArray(raw.env) || !raw.env.every((e) => typeof e === "string" && ENV_NAME.test(e))) {
    bad(`"env" must be a list of environment variable NAMES`);
  }
  if (!isObject(raw.budget_usd)) {
    bad(`"budget_usd" must be an object`);
  } else {
    for (const key of Object.keys(raw.budget_usd)) {
      if (!(BUDGET_KEYS as readonly string[]).includes(key)) bad(`unknown key "budget_usd.${key}"`);
    }
    const { default: d, max } = raw.budget_usd;
    if (typeof d !== "number" || !(d >= 0) || typeof max !== "number" || !(max >= 0)) {
      bad(`"budget_usd.default" and "budget_usd.max" must be non-negative numbers`);
    } else if (d > max) {
      bad(`"budget_usd.default" must not exceed "budget_usd.max"`);
    }
  }
  if (errors.length > 0) throw new TargetError(errors.join("\n"));
  return {
    name: name as TargetName,
    origin: origin as string,
    project_id: projectId as string,
    protected: raw.protected as boolean,
    env: raw.env as string[],
    budget_usd: raw.budget_usd as Target["budget_usd"],
  };
}

/** Loads `<targetsDir>/<name>.json`. `name` must be one of the closed target names. */
export function loadTarget(targetsDir: string, name: string, envSource: EnvSource = process.env): Target {
  if (!(TARGET_NAMES as readonly string[]).includes(name)) {
    throw new TargetError(`unknown target "${name}" (expected ${TARGET_NAMES.join(" or ")})`);
  }
  const file = join(targetsDir, `${name}.json`);
  if (!existsSync(file)) throw new TargetError(`target ${name}: file not found: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new TargetError(`target ${name}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseTarget(parsed, name, envSource);
}

/**
 * Layer 1. Returns the REFUSED reason, or null when the pack may proceed to the later guards.
 * On production: a destructive pack, or one whose `targets` does not list production, is refused.
 * On any target: a pack whose `targets` does not list it is not run there.
 */
export function targetGuard(pack: Pack, target: Target): string | null {
  if (target.name === "production") {
    if (pack.destructive) return "destructive-on-production";
    if (!pack.targets.includes("production")) return "not-listed-for-production";
    return null;
  }
  if (!pack.targets.includes(target.name)) return `not-listed-for-${target.name}`;
  return null;
}
