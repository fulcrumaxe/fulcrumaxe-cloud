/**
 * The pack manifest: `packs/<id>/pack.json`, its closed schema and its loader. Pure; no browser, no network.
 *
 * Rejected at load, each naming the pack and the offending key or need: an unknown key, a missing key, an
 * unknown need, an `@ui` pack that does not list all three device projects, `model_spend: true` on any tier
 * but `full`. (The `est_usd` against measured p90 rule needs `cost-measured.json`, which lands with T13a.)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeErrors, type Probe } from "./probes.js";

export const TIERS = ["smoke", "standard", "full"] as const;
export type Tier = (typeof TIERS)[number];

export const TARGET_NAMES = ["staging", "production"] as const;
export type TargetName = (typeof TARGET_NAMES)[number];

export const PROJECTS = ["desktop", "phone", "tablet"] as const;
export type Project = (typeof PROJECTS)[number];

export const COST_CLASSES = ["free", "cheap", "model-token", "sandbox-minutes"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

/** Needs written as a bare word. */
export const BARE_NEEDS = [
  "bypass",
  "stripe-test",
  "host-capacity",
  "signin:scripted",
  "model-key",
  "test-repo",
  "caps-set",
  "sandbox",
  "webhook-sink",
] as const;

/** Needs written as `<prefix>:<argument>` (the argument must be non-empty). */
export const PARAM_NEED_PREFIXES = ["session", "github-app", "fresh-state", "api-token"] as const;

/** The needs this slice can evaluate from the environment or the host alone (needs.ts). */
export const ENV_NEEDS = ["bypass", "stripe-test", "host-capacity"] as const;

export function isKnownNeed(need: string): boolean {
  if ((BARE_NEEDS as readonly string[]).includes(need)) return true;
  const colon = need.indexOf(":");
  if (colon <= 0) return false;
  const prefix = need.slice(0, colon);
  const arg = need.slice(colon + 1);
  return (PARAM_NEED_PREFIXES as readonly string[]).includes(prefix) && arg.length > 0;
}

export interface Pack {
  id: string;
  rows: string[];
  tier: Tier;
  tags: string[];
  targets: TargetName[];
  destructive: boolean;
  model_spend: boolean;
  projects: Project[];
  needs: string[];
  /** Declared refusal probes (`{ method, path, expect }`); the schema is in probes.ts. */
  probes: Probe[];
  cost: { class: CostClass; est_usd: number; est_sandbox_min: number };
  retry: number;
  runs_last: boolean;
  paths: string[];
}

const PACK_KEYS = [
  "id",
  "rows",
  "tier",
  "tags",
  "targets",
  "destructive",
  "model_spend",
  "projects",
  "needs",
  "probes",
  "cost",
  "retry",
  "runs_last",
  "paths",
] as const;
const COST_KEYS = ["class", "est_usd", "est_sandbox_min"] as const;

export class ManifestError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("\n"));
    this.name = "ManifestError";
    this.errors = errors;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

function nonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Validates one parsed `pack.json`. `dirName` is the folder it was found in: the id must equal it.
 * Throws ManifestError listing every problem found, each prefixed with the pack.
 */
export function validatePack(raw: unknown, dirName: string): Pack {
  const errors: string[] = [];
  const label = `pack ${dirName}`;
  const bad = (msg: string): void => {
    errors.push(`${label}: ${msg}`);
  };
  if (!isObject(raw)) throw new ManifestError([`${label}: pack.json must be a JSON object`]);

  for (const key of Object.keys(raw)) {
    if (!(PACK_KEYS as readonly string[]).includes(key)) bad(`unknown key "${key}"`);
  }
  for (const key of PACK_KEYS) {
    if (!(key in raw)) bad(`missing key "${key}"`);
  }

  if (typeof raw.id !== "string" || raw.id !== dirName) bad(`"id" must equal the folder name "${dirName}"`);
  if (!stringList(raw.rows)) bad(`"rows" must be a list of non-empty strings`);
  if (!(TIERS as readonly unknown[]).includes(raw.tier)) bad(`"tier" must be one of ${TIERS.join(", ")}`);
  if (!stringList(raw.tags) || !raw.tags.every((t) => t.startsWith("@"))) bad(`"tags" must be a list of strings starting with "@"`);
  if (
    !Array.isArray(raw.targets) ||
    raw.targets.length === 0 ||
    !raw.targets.every((t) => (TARGET_NAMES as readonly unknown[]).includes(t))
  ) {
    bad(`"targets" must be a non-empty list drawn from ${TARGET_NAMES.join(", ")}`);
  }
  if (typeof raw.destructive !== "boolean") bad(`"destructive" must be a boolean`);
  if (typeof raw.model_spend !== "boolean") bad(`"model_spend" must be a boolean`);
  if (
    !Array.isArray(raw.projects) ||
    raw.projects.length === 0 ||
    !raw.projects.every((p) => (PROJECTS as readonly unknown[]).includes(p)) ||
    new Set(raw.projects).size !== raw.projects.length
  ) {
    bad(`"projects" must be a non-empty list of distinct values drawn from ${PROJECTS.join(", ")}`);
  }
  if (!stringList(raw.needs)) {
    bad(`"needs" must be a list of non-empty strings`);
  } else {
    for (const need of raw.needs) {
      if (!isKnownNeed(need)) bad(`unknown need "${need}"`);
    }
  }
  if ("probes" in raw) errors.push(...probeErrors(raw.probes, dirName));
  if (!isObject(raw.cost)) {
    bad(`"cost" must be an object`);
  } else {
    for (const key of Object.keys(raw.cost)) {
      if (!(COST_KEYS as readonly string[]).includes(key)) bad(`unknown key "cost.${key}"`);
    }
    if (!(COST_CLASSES as readonly unknown[]).includes(raw.cost.class)) bad(`"cost.class" must be one of ${COST_CLASSES.join(", ")}`);
    if (!nonNegativeNumber(raw.cost.est_usd)) bad(`"cost.est_usd" must be a non-negative number`);
    if (!nonNegativeNumber(raw.cost.est_sandbox_min)) bad(`"cost.est_sandbox_min" must be a non-negative number`);
  }
  if (typeof raw.retry !== "number" || !Number.isInteger(raw.retry) || raw.retry < 0) bad(`"retry" must be a non-negative integer`);
  if (typeof raw.runs_last !== "boolean") bad(`"runs_last" must be a boolean`);
  if (!stringList(raw.paths)) bad(`"paths" must be a list of non-empty strings`);

  // Cross-field rules (only meaningful when the fields above are well formed).
  if (stringList(raw.tags) && raw.tags.includes("@ui") && Array.isArray(raw.projects)) {
    const missing = PROJECTS.filter((p) => !(raw.projects as unknown[]).includes(p));
    if (missing.length > 0) bad(`a "@ui" pack must list all three projects; missing ${missing.join(", ")}`);
  }
  if (raw.model_spend === true && raw.tier !== "full") bad(`"model_spend": true is only allowed on tier "full"`);

  if (errors.length > 0) throw new ManifestError(errors);
  return raw as unknown as Pack;
}

/** Loads every `<packsDir>/<id>/pack.json`, sorted by id. Reports all packs' problems together. */
export function loadPacks(packsDir: string): Pack[] {
  if (!existsSync(packsDir)) throw new ManifestError([`packs directory not found: ${packsDir}`]);
  const packs: Pack[] = [];
  const errors: string[] = [];
  const dirs = readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const dir of dirs) {
    const file = join(packsDir, dir, "pack.json");
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      errors.push(`pack ${dir}: pack.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    try {
      packs.push(validatePack(parsed, dir));
    } catch (err) {
      if (err instanceof ManifestError) errors.push(...err.errors);
      else throw err;
    }
  }
  if (errors.length > 0) throw new ManifestError(errors);
  return packs;
}
