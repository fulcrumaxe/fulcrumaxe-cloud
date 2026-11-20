/**
 * `fx-runner vm install [--yes] [--dry-run]` and the hidden root side `vm root-apply` (D#587 B-2a-2 PR-3).
 *
 * Order, and what stops what:
 *   1. host facts (read at the bin edge) -> `buildInstallPlan` (pure);
 *   2. `stageBundle`, as the ordinary user: a bundle that fails verification ends the command here, with no root call at all;
 *   3. print the whole plan and the exact list of root steps; `--dry-run` stops here and has made no root call;
 *   4. one confirmation (skipped by `--yes`);
 *   5. ONE root call: `sudo -- <this program> vm root-apply`, the checked request on its standard input; the root side applies it
 *      (./rootApply) and answers with one JSON report line, which is printed as what was done and what was undone.
 */
import { CliError } from "../cliError.js";
import { createHash } from "node:crypto";
import type { TufClient } from "../update/tuf.js";
import { hostArch, stageBundle } from "./bundle.js";
import { buildInstallPlan, renderCreateList, type HostFacts } from "./installPlan.js";
import { probeHelper } from "./helperProbe.js";
import { buildRootActions, checkRequest, describeAction, type RootAction, type RootRequest } from "./rootActions.js";
import { applyRootActions, type RootOps, type RootReport } from "./rootApply.js";

export const INSTALL_USAGE = "usage: fx-runner vm install [--yes] [--dry-run]";
/** The RAM of the smallest template, which sets how many sandboxes the default limits allow. FU-97 tracks deriving it from the template metadata; until then it is this constant. */
export const SMALLEST_TEMPLATE_RAM_MB = 512;

export interface InstallHost {
  /** The machine's facts, read at the bin edge: CPUs, MemTotal, the taken ids, and the invoking user (before sudo). */
  facts(): Promise<Omit<HostFacts, "smallestTemplateRamMb">>;
  nodeArch: string;
  tuf: Pick<TufClient, "listTargets" | "fetchTarget">;
  /** The one root call: `sudo -- <program> vm root-apply` with the request on standard input. Resolves with the report line it printed. */
  root: { run(request: RootRequest): Promise<{ readonly code: number | null; readonly stdout: string }> };
  confirm(question: string): Promise<boolean>;
  /** Whether this machine can take the install at all (`hostRefusal`, run on the real file system): a sentence, or undefined. Asked before anything is staged or sudo is called. */
  hostRefusal(actions: readonly RootAction[]): string | undefined;
  tmpRoot?: string;
}

export interface RootSideHost {
  euid: number;
  /** The `SUDO_UID` sudo set for this process: the root side believes the request's runner only if it is that user. */
  sudoUid: string | undefined;
  readStdin(): Promise<string>;
  ops: Pick<RootOps, "run">;
}

/** The fixed argument list of the one root call. Nothing in it comes from the plan. */
export function buildRootArgv(sudo: string, selfCommand: readonly string[]): string[] {
  return [sudo, "--", ...selfCommand, "vm", "root-apply"];
}

const sha256Text = (t: string): string => createHash("sha256").update(t).digest("hex");

function printReport(report: RootReport, out: (line: string) => void): void {
  const list = (title: string, items: readonly string[]): void => {
    if (items.length > 0) out([title, ...items.map((i) => `  ${i}`)].join("\n"));
  };
  if (report.ok && report.done.length === 0) return out("Already installed: nothing was changed.");
  list("Done:", report.done);
  list("Already in place, not changed:", report.unchanged);
  if (!report.ok) {
    out(`Failed: ${report.failed ?? "unknown step"}`);
    list("Undone, last first:", report.undone);
    list("COULD NOT BE UNDONE, remove by hand:", report.undoFailed);
    if (report.undoFailed.length === 0) out("Everything this run changed has been put back.");
  } else out("Installed. The helper answers on its socket. Log out and in again so the new group takes effect, then run `fx-runner doctor`.");
}

function parseReport(stdout: string): RootReport | undefined {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const r = JSON.parse(line) as Partial<RootReport>;
    const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof r.ok === "boolean" && strs(r.done) && strs(r.unchanged) && strs(r.undone) && strs(r.undoFailed)) return r as RootReport;
  } catch {
    // fx-swallow-ok: no report line is reported as "no report" below
  }
  return undefined;
}

export async function installCommand(args: readonly string[], host: InstallHost, out: (line: string) => void): Promise<number> {
  const unknown = args.filter((a) => a !== "--yes" && a !== "--dry-run");
  if (unknown.length > 0 || new Set(args).size !== args.length) throw new CliError(INSTALL_USAGE, 2);
  const yes = args.includes("--yes");
  const dryRun = args.includes("--dry-run");
  const facts = await host.facts();
  const plan = buildInstallPlan({ ...facts, smallestTemplateRamMb: SMALLEST_TEMPLATE_RAM_MB });
  const staged = await stageBundle({ tuf: host.tuf, arch: hostArch(host.nodeArch), ...(host.tmpRoot === undefined ? {} : { tmpRoot: host.tmpRoot }) });
  try {
    const actions = buildRootActions(plan, staged, facts.runner, sha256Text);
    // before anything is printed or sudo is asked for: a NixOS machine, or a link on the way to a target, is refused here in one sentence
    const refusal = host.hostRefusal(actions);
    if (refusal !== undefined) throw new CliError(refusal, 2);
    const { limits, uidRange, gidRange } = plan;
    out("This install will create:");
    for (const l of renderCreateList(plan.createList)) out(l);
    out(`Limits: ${limits.max_sandboxes} sandboxes, ${limits.max_vcpus} vCPUs, ${limits.max_mem_mb} MB (change later with fx-runner config)`);
    out(`Sandbox ids: uid ${uidRange.first}-${uidRange.first + uidRange.count - 1}, gid ${gidRange.first}-${gidRange.first + gidRange.count - 1}`);
    out(`Unit ${plan.unit.path}:\n${plan.unit.text}`);
    out("Root steps, in order (one root call runs them; a failure undoes the finished ones, last first):");
    actions.forEach((a, i) => out(`  ${String(i + 1).padStart(2)}. ${describeAction(a)}`));
    if (dryRun) {
      out("Dry run: no root call was made and nothing was changed.");
      return 0;
    }
    if (!yes && !(await host.confirm("Run these steps as root now? [y/N] "))) {
      out("Cancelled: nothing was changed.");
      return 1;
    }
    const result = await host.root.run({ version: 1, runnerUid: facts.runner.uid, runnerUser: facts.runner.user, actions });
    const report = parseReport(result.stdout);
    if (report === undefined) throw new CliError(result.code === 0 ? "the root phase gave no report" : `the root phase did not run (exit ${result.code ?? "none"}); nothing is known to have changed`);
    printReport(report, out);
    return report.ok ? 0 : 1;
  } finally {
    staged.cleanup();
  }
}

/** `vm root-apply`: the root side. The request comes from standard input only; the report goes to standard output as one JSON line. */
export async function rootApplyCommand(host: RootSideHost, out: (line: string) => void): Promise<number> {
  const text = await host.readStdin();
  if (text.length > 1 << 20) throw new CliError("root phase refused: the request is too large", 2);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a fixed sentence replaces the parser's, which would quote the input
    throw new CliError("root phase refused: the request is not JSON", 2);
  }
  const request = checkRequest(value, host.euid);
  // The runner named in the request must be the user who ran sudo, and the account database must agree on its uid.
  if (host.sudoUid !== String(request.runnerUid)) throw new CliError("root phase refused: the runner uid is not the user who ran sudo", 2);
  const who = await host.ops.run("getent", ["passwd", request.runnerUser]);
  if (who.code !== 0 || who.output.trim().split(":")[2] !== String(request.runnerUid)) throw new CliError("root phase refused: the runner user and uid do not match the account database", 2);
  const report = await applyRootActions(request, { run: host.ops.run, probe: (socket) => probeHelper(socket) });
  out(JSON.stringify(report));
  return report.ok ? 0 : 1;
}
