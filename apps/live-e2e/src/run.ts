/**
 * The `run` command's engine: turn a plan into one Playwright invocation per pack, run them one after another,
 * and write `results.json`, `summary.md` and a scrubbed log per pack next to the plan.
 *
 * Least privilege for the child: it gets an explicit, named list of variables (the host basics Playwright needs,
 * the target's two address variables, and the secrets of the needs this pack declares), never the parent's whole
 * environment. A pack that needs `bypass` gets the bypass secret; one that does not, does not.
 *
 * The browsers are Playwright's own and come from the host (PLAYWRIGHT_BROWSERS_PATH); nothing is downloaded.
 * One pack at a time, and the config caps the workers inside it (`MAX_WORKERS`): the runner shares a machine.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { OUTPUT_DIR_ENV_NAME, TARGET_ENV_NAME, WORKERS_ENV_NAME } from "./limits.js";
import type { Pack } from "./manifest.js";
import { MASK_FILE_ENV } from "./mask.js";
import { BYPASS_ENV, STRIPE_RESTRICTED_KEY_ENV } from "./needs.js";
import type { Plan } from "./plan.js";
import { buildResults, notRunFromPlan, scrubbedText, writeReport, type PackResult, type Results } from "./report.js";
import { ScrubError, type ScrubContext } from "./scrub.js";
import { fenceConfigFor, PRODUCTION_ORIGIN_ENV, type Target } from "./targets.js";

/** Host basics the browser needs. Values are copied by name, only when set. */
export const HOST_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LD_LIBRARY_PATH",
  "FONTCONFIG_FILE",
  "FONTCONFIG_PATH",
  MASK_FILE_ENV,
] as const;

/** The secret each env-only need hands to a pack that declares it. */
const NEED_ENV: Record<string, string> = { bypass: BYPASS_ENV, "stripe-test": STRIPE_RESTRICTED_KEY_ENV };

export interface Invocation {
  packId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  devices: string[];
}

export interface ExecResult {
  code: number;
  output: string;
}

export type Executor = (inv: Invocation) => Promise<ExecResult>;

export function childEnv(pack: Pack, target: Target, source: Record<string, string | undefined>, outputDir: string): Record<string, string> {
  const out: Record<string, string> = { [TARGET_ENV_NAME]: target.name, [OUTPUT_DIR_ENV_NAME]: outputDir };
  const names = [...HOST_ENV_NAMES, target.origin_env, target.project_id_env, WORKERS_ENV_NAME];
  // A staging run keeps out of the production origin (the fence), so it must be told which one that is.
  if (target.name === "staging") names.push(PRODUCTION_ORIGIN_ENV);
  for (const need of pack.needs) {
    const name = NEED_ENV[need];
    if (name !== undefined && target.env.includes(name)) names.push(name);
  }
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function playwrightCli(): string {
  return createRequire(import.meta.url).resolve("@playwright/test/cli");
}

export function buildInvocations(
  plan: Plan,
  packs: Pack[],
  target: Target,
  opts: { root: string; env: Record<string, string | undefined>; outDir: string; cli?: string },
): Invocation[] {
  // Fail closed before any child process exists: a staging run without the production origin would run unfenced.
  fenceConfigFor(target, join(opts.root, "targets"), opts.env);
  const cli = opts.cli ?? playwrightCli();
  const out: Invocation[] = [];
  for (const sel of plan.selected) {
    const pack = packs.find((p) => p.id === sel.id);
    if (pack === undefined) continue;
    const args = [cli, "test", "--config", join(opts.root, "playwright.config.ts"), `/packs/${pack.id}/`];
    for (const project of pack.projects) args.push("--project", project);
    args.push("--retries", String(pack.retry));
    out.push({
      packId: pack.id,
      command: process.execPath,
      args,
      env: childEnv(pack, target, opts.env, join(opts.outDir, "test-results", pack.id)),
      devices: [...pack.projects],
    });
  }
  return out;
}

/** Runs the child with a hard time limit; its output (both streams) is returned, never printed raw. */
export const spawnExecutor =
  (cwd: string, timeoutMs = 10 * 60_000): Executor =>
  (inv) =>
    new Promise((resolve) => {
      const child = spawn(inv.command, inv.args, { cwd, env: inv.env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
      child.on("error", (err) => resolve({ code: 127, output: `${output}\nspawn failed: ${err.message}` }));
      child.on("close", (code, signal) => resolve({ code: code ?? (signal === null ? 1 : 124), output }));
    });

export interface RunOutput {
  results: Results;
  failed: boolean;
}

export async function runPlan(
  plan: Plan,
  invocations: Invocation[],
  exec: Executor,
  ctx: ScrubContext,
  outDir: string,
  clock: () => number = Date.now,
  say: (line: string) => void = () => undefined,
): Promise<RunOutput> {
  const started = clock();
  const ran: PackResult[] = [];
  for (const inv of invocations) {
    const t0 = clock();
    const { code, output } = await exec(inv);
    let text: string;
    try {
      text = scrubbedText(output, ctx);
    } catch (err) {
      if (!(err instanceof ScrubError)) throw err;
      text = "[log withheld: a secret survived redaction]\n";
    }
    const logFile = join(outDir, "logs", `${inv.packId}.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, text);
    say(`${inv.packId}: ${code === 0 ? "PASS" : `FAIL (exit ${code})`}`);
    ran.push({ id: inv.packId, outcome: code === 0 ? "PASS" : "FAIL", duration_ms: clock() - t0, devices: inv.devices, cost_usd: 0 });
  }
  const results = buildResults({
    target: plan.target,
    trigger: plan.trigger,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(clock()).toISOString(),
    packs: [...ran, ...notRunFromPlan(plan)],
  });
  writeReport(outDir, results, ctx);
  return { results, failed: ran.some((p) => p.outcome === "FAIL") };
}
