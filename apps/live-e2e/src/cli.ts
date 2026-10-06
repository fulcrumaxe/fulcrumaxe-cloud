/**
 * The `live-e2e` command line. This slice has one command, `plan`; `run` arrives with T1b.
 *
 *   live-e2e plan --target <staging|production> [--tier smoke|standard|full] [--pack a,b] [--tag @x]
 *                 [--trigger dispatch|deploy|nightly|weekly|poll] [--out <file>]
 *
 * `--tier` defaults to smoke only when neither `--pack` is given (naming a pack alone selects just that
 * pack). `--changed-from` and `--budget-usd` are not accepted yet (T4 and T13a); an unknown flag is an error.
 *
 * Exit codes: 0 plan written; 1 the plan was written (or could not be) because of a refusal of a pack the
 * caller named, or EMPTY-SELECTION; 2 usage, manifest or target errors.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks, ManifestError, TIERS, type Tier } from "./manifest.js";
import { readHostProbe, type HostProbe } from "./needs.js";
import { buildPlan, describeOutcome } from "./plan.js";
import { EmptySelectionError, TRIGGERS, UnknownPackError, type Trigger } from "./select.js";
import { loadTarget, TargetError } from "./targets.js";

export interface Args {
  command: "plan";
  target: string;
  tier?: Tier;
  packs: string[];
  tag?: string;
  trigger?: Trigger;
  out?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = ["--target", "--tier", "--pack", "--tag", "--trigger", "--out"] as const;

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command === "run") throw new UsageError("`run` is not available yet (it lands with T1b); use `plan`");
  if (command !== "plan") throw new UsageError("usage: live-e2e plan --target <staging|production> [--tier t] [--pack a,b] [--tag @x] [--trigger t] [--out file]");
  const seen = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] as string;
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) throw new UsageError(`unknown argument "${flag}"`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    seen.set(flag, [...(seen.get(flag) ?? []), value]);
    i += 1;
  }
  const one = (flag: string): string | undefined => {
    const v = seen.get(flag);
    if (v === undefined) return undefined;
    if (v.length > 1) throw new UsageError(`${flag} given more than once`);
    return v[0];
  };
  const target = one("--target");
  if (target === undefined) throw new UsageError("--target is required");
  const tier = one("--tier");
  if (tier !== undefined && !(TIERS as readonly string[]).includes(tier)) throw new UsageError(`--tier must be one of ${TIERS.join(", ")}`);
  const trigger = one("--trigger");
  if (trigger !== undefined && !(TRIGGERS as readonly string[]).includes(trigger)) throw new UsageError(`--trigger must be one of ${TRIGGERS.join(", ")}`);
  const tag = one("--tag");
  if (tag !== undefined && !tag.startsWith("@")) throw new UsageError(`--tag must start with "@"`);
  const packs = (seen.get("--pack") ?? []).flatMap((v) => v.split(",")).filter((v) => v.length > 0);
  const args: Args = { command: "plan", target, packs };
  if (tier !== undefined) args.tier = tier as Tier;
  if (tag !== undefined) args.tag = tag;
  if (trigger !== undefined) args.trigger = trigger as Trigger;
  const out = one("--out");
  if (out !== undefined) args.out = out;
  return args;
}

export interface Io {
  /** The package root: `packs/` and `targets/` are read from here. */
  root: string;
  cwd: string;
  env: Record<string, string | undefined>;
  host: HostProbe;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function main(argv: string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 2;
  }
  try {
    const target = loadTarget(join(io.root, "targets"), args.target, io.env);
    const packs = loadPacks(join(io.root, "packs"));
    const tier = args.tier ?? (args.packs.length === 0 ? "smoke" : undefined);
    const plan = buildPlan({
      packs,
      target,
      named: args.packs,
      needs: { env: io.env, host: io.host },
      ...(tier !== undefined ? { tier } : {}),
      ...(args.tag !== undefined ? { tag: args.tag } : {}),
      ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
    });
    const outFile = resolve(io.cwd, args.out ?? "plan.json");
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(plan, null, 2)}\n`);
    for (const o of plan.packs) io.stdout(describeOutcome(o));
    io.stdout(`plan written to ${outFile}`);
    const namedRefusals = plan.refused.filter((r) => r.named);
    for (const r of namedRefusals) io.stderr(`REFUSED ${r.reason} (pack ${r.id})`);
    return namedRefusals.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof EmptySelectionError) {
      io.stderr(err.message);
      return 1;
    }
    if (err instanceof UnknownPackError || err instanceof ManifestError || err instanceof TargetError) {
      io.stderr(err.message);
      return 2;
    }
    throw err;
  }
}

export async function runFromProcess(argv: string[]): Promise<number> {
  return main(argv, {
    root: packageRoot(),
    cwd: process.cwd(),
    env: process.env,
    host: readHostProbe(),
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  });
}
