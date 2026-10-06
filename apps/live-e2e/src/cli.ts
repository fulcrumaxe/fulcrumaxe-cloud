/**
 * The `live-e2e` command line. Commands: `plan`, `run` (the same selection, then Playwright per pack) and
 * `scrub` (the upload gate).
 *
 *   live-e2e plan --target <staging|production> [--tier smoke|standard|full] [--pack a,b] [--tag @x]
 *                 [--changed-from <base>..<head>] [--trigger dispatch|deploy|nightly|weekly|poll] [--out <file>]
 *
 * `--tier` defaults to smoke only when neither `--pack` is given (naming a pack alone selects just that
 * pack). `--changed-from` adds the packs its changed files route to (never a full pack, never fewer packs than
 * the tier gave); `--budget-usd` is not accepted yet (T13a); an unknown flag is an error.
 *
 * Exit codes: 0 plan written; 1 the plan was written (or could not be) because of a refusal of a pack the
 * caller named, or EMPTY-SELECTION; 2 usage, manifest or target errors.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacks, ManifestError, TIERS, type Tier } from "./manifest.js";
import { MASK_FILE_ENV, MaskError, MaskRegistry } from "./mask.js";
import { readHostProbe, type HostProbe } from "./needs.js";
import { buildPlan, describeOutcome } from "./plan.js";
import { buildInvocations, runPlan, spawnExecutor, type Executor } from "./run.js";
import { computeRouting, parseRange } from "./routing.js";
import { describeFinding, includeUnscannedRefusal, scanDir, type ScanResult } from "./scrub.js";
import { EmptySelectionError, TRIGGERS, UnknownPackError, type Trigger } from "./select.js";
import { loadTarget, TargetError } from "./targets.js";

export interface Args {
  command: "plan" | "run";
  target: string;
  tier?: Tier;
  packs: string[];
  tag?: string;
  trigger?: Trigger;
  changedFrom?: string;
  out?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = ["--target", "--tier", "--pack", "--tag", "--trigger", "--changed-from", "--out"] as const;

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "plan" && command !== "run") throw new UsageError("usage: live-e2e plan|run --target <staging|production> [--tier t] [--pack a,b] [--tag @x] [--changed-from base..head] [--trigger t] [--out file]");
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
  const args: Args = { command, target, packs };
  if (tier !== undefined) args.tier = tier as Tier;
  if (tag !== undefined) args.tag = tag;
  if (trigger !== undefined) args.trigger = trigger as Trigger;
  const changedFrom = one("--changed-from");
  if (changedFrom !== undefined) {
    try {
      parseRange(changedFrom);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    args.changedFrom = changedFrom;
  }
  const out = one("--out");
  if (out !== undefined) args.out = out;
  return args;
}

export interface Io {
  /** The package root: `packs/`, `targets/` and `routing-ledger.json` are read from here. */
  root: string;
  /** The git checkout `--changed-from` diffs in. Defaults to two levels above `root` (apps/live-e2e). */
  repoRoot?: string;
  /** Test seams for `run`: the Playwright runner and the path of its CLI. */
  exec?: Executor;
  cli?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  host: HostProbe;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * `live-e2e scrub --dir <folder> [--manifest <file>] [--target <name> --include-unscanned <glob>]...`: the gate in
 * front of the artifact upload. Only text files and PNG screenshots may be uploaded; every other file is listed as
 * `not-uploaded:<type>` and left out (not an error). The manifest is the upload set: `upload`, `not_uploaded` and
 * `included_unscanned`.
 *
 * `--include-unscanned <glob>` (repeatable) is the debugging opt-in: matching files that are not on the allowlist
 * are put in the upload set WITHOUT being opened. It needs `--target`, and is refused on production (exit 2).
 *
 * Exit 0 when nothing matched, 1 when a secret was found or an allowed file is not what it claims (each finding
 * printed as path, kind and route, never the value), 2 on usage errors and refusals. Runtime secrets come from the
 * file named by LIVE_E2E_MASK_FILE; the run's own environment is checked too.
 */
function scrubCommand(argv: string[], io: Io): number {
  const usage = "usage: live-e2e scrub --dir <folder> [--manifest <file>] [--target <name> --include-unscanned <glob>]...";
  let dir: string | undefined;
  let manifest: string | undefined;
  let target: string | undefined;
  const globs: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      io.stderr(usage);
      return 2;
    }
    if (flag === "--dir" && dir === undefined) dir = value;
    else if (flag === "--manifest" && manifest === undefined) manifest = value;
    else if (flag === "--target" && target === undefined) target = value;
    else if (flag === "--include-unscanned") globs.push(value);
    else {
      io.stderr(usage);
      return 2;
    }
  }
  if (dir === undefined) {
    io.stderr(usage);
    return 2;
  }
  if (globs.length > 0) {
    if (target === undefined) {
      io.stderr("--include-unscanned needs --target");
      return 2;
    }
    try {
      const refusal = includeUnscannedRefusal(loadTarget(join(io.root, "targets"), target, io.env).name);
      if (refusal !== null) {
        io.stderr(`REFUSED ${refusal}`);
        return 2;
      }
    } catch (err) {
      if (err instanceof TargetError) {
        io.stderr(err.message);
        return 2;
      }
      throw err;
    }
  }
  const maskFile = io.env[MASK_FILE_ENV];
  let result: ScanResult;
  try {
    const registry = new MaskRegistry({ emit: () => undefined, ...(maskFile ? { file: maskFile } : {}) });
    result = scanDir(resolve(io.cwd, dir), { registry, env: io.env }, { includeUnscanned: globs });
  } catch (err) {
    // Never an uncaught throw: a gate that crashes looks like a leak with no path. The message of a MaskError
    // names a file, not a value; anything else is reported without its text.
    io.stderr(`SECRET .: ${err instanceof MaskError ? `unscannable:${err.message}` : "unscannable:internal-error"} (plain)`);
    io.stdout("scrub: could not complete, 1 finding(s)");
    return 1;
  }
  for (const n of result.notUploaded) io.stdout(`not-uploaded:${n.type} ${n.path}`);
  for (const f of result.includedUnscanned) io.stdout(`included-unscanned ${f}`);
  for (const f of result.findings) io.stderr(`SECRET ${describeFinding(f)}`);
  if (manifest !== undefined) {
    const file = resolve(io.cwd, manifest);
    mkdirSync(dirname(file), { recursive: true });
    const body = { version: 1, upload: result.upload, not_uploaded: result.notUploaded, included_unscanned: result.includedUnscanned };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  }
  io.stdout(`scrub: ${result.files} file(s) scanned, ${result.upload.length} to upload, ${result.notUploaded.length} not uploaded, ${result.findings.length} finding(s)`);
  return result.findings.length > 0 ? 1 : 0;
}

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv[0] === "scrub") return scrubCommand(argv.slice(1), io);
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
    const routing =
      args.changedFrom === undefined
        ? undefined
        : await computeRouting({
            changedFrom: args.changedFrom,
            packs,
            repoRoot: io.repoRoot ?? resolve(io.root, "..", ".."),
            ledgerFile: join(io.root, "routing-ledger.json"),
          });
    const plan = buildPlan({
      ...(routing !== undefined ? { routing } : {}),
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
    if (plan.routing_fallback !== null) io.stdout(`routing fell back to every pack at or below standard: ${plan.routing_fallback}`);
    for (const o of plan.packs) io.stdout(describeOutcome(o));
    io.stdout(`plan written to ${outFile}`);
    const namedRefusals = plan.refused.filter((r) => r.named);
    for (const r of namedRefusals) io.stderr(`REFUSED ${r.reason} (pack ${r.id})`);
    let failed = false;
    if (args.command === "run") {
      const outDir = dirname(outFile);
      const invocations = buildInvocations(plan, packs, target, { root: io.root, env: io.env, outDir, ...(io.cli ? { cli: io.cli } : {}) });
      const maskFile = io.env[MASK_FILE_ENV];
      const registry = new MaskRegistry({ emit: () => undefined, ...(maskFile ? { file: maskFile } : {}) });
      const ctx = { registry, env: io.env, declaredEnvNames: target.env };
      const exec = io.exec ?? spawnExecutor(io.root);
      failed = (await runPlan(plan, invocations, exec, ctx, outDir, Date.now, io.stdout)).failed;
      io.stdout(`results written to ${outDir}`);
    }
    return namedRefusals.length > 0 || failed ? 1 : 0;
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
