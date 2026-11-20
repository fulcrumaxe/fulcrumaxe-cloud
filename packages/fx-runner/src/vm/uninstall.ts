/**
 * `fx-runner vm uninstall [--yes] [--dry-run] [--force]` and the hidden root side `vm root-remove` (D#587 B-2a-2 PR-4).
 *
 * The same shape as install, in reverse: host facts (read at the bin edge) -> the removal list, from the install plan's create list ->
 * refuse up front on a machine whose helper is configured declaratively (NixOS, or a link on the way to a target) -> print it -> `--dry-run`
 * stops with no root call -> one confirmation (skipped by `--yes`) -> ONE root call whose one JSON report line is printed. On a host where
 * nothing install makes is present, it says "Not installed" and makes no root call at all, so a second run is a no-op.
 */
import { CliError } from "../cliError.js";
import { LAYOUT, renderRemoveList } from "./installPlan.js";
import { applyUninstall, type UninstallReport } from "./uninstallApply.js";
import { buildUninstallActions, checkUninstallRequest, describeUninstall, uninstallPlan, type UninstallRequest } from "./uninstallActions.js";
import type { RootSideHost } from "./install.js";
import type { UninstallAction } from "./uninstallActions.js";
import type { HelperSandboxes } from "./helperSandboxes.js";

/** What `snapshot_dir` holds, read at the bin edge as the runner user: `dir` is the setting (absent when unset), `summary` is absent when it could not be read. */
export interface SnapshotFacts {
  readonly dir: string | undefined;
  readonly summary: { readonly count: number; readonly bytes: number } | undefined;
}

export const UNINSTALL_USAGE = "usage: fx-runner vm uninstall [--yes] [--dry-run] [--force]";

export interface UninstallHost {
  /** Read at the bin edge, before sudo: the invoking user, and which of `paths` exist (a no-follow look). */
  facts(paths: readonly string[]): Promise<{ readonly runner: { readonly user: string; readonly uid: number }; readonly existing: readonly string[] }>;
  /** Whether this machine can take the uninstall at all (`hostRefusal`, run on the real file system): a sentence, or undefined. Asked before sudo is called. */
  hostRefusal(actions: readonly UninstallAction[]): string | undefined;
  /** The one root call: `sudo -- <program> vm root-remove` with the request on standard input. */
  root: { run(request: UninstallRequest): Promise<{ readonly code: number | null; readonly stdout: string }> };
  confirm(question: string): Promise<boolean>;
  /** The runner user's own view of the helper's sandboxes; its `list` rejects when the helper does not answer. Never called as root. */
  helper: HelperSandboxes;
  snapshots(): Promise<SnapshotFacts>;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The same place as the one install made, however the setting spells it (a trailing slash, a doubled one). */
const isInstallsOwn = (dir: string): boolean => {
  const clean = dir.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  return clean === LAYOUT.snapshotDir;
};

function describeKept(s: SnapshotFacts): string {
  // Unset in the runner settings means the helper uses the directory install made, and so does a setting that names it: that one is root-only and goes with the uninstall if it is empty.
  if (s.dir === undefined || isInstallsOwn(s.dir)) return `The snapshot directory ${LAYOUT.snapshotDir} is root-only: it is removed if it is empty, and if it still holds files it is left in place and listed in the report below.`;
  if (s.summary === undefined) return `Kept, not touched: your snapshot_dir ${s.dir} and the sandbox data in it. It could not be read, so its snapshots could not be counted.`;
  return `Kept, not touched: your snapshot_dir ${s.dir} holds ${plural(s.summary.count, "snapshot", "snapshots")}, ${s.summary.bytes} bytes in all.`;
}

/** The fixed argument list of the one root call. Nothing in it comes from the plan. */
export function buildRemoveArgv(sudo: string, selfCommand: readonly string[]): string[] {
  return [sudo, "--", ...selfCommand, "vm", "root-remove"];
}

function printReport(report: UninstallReport, out: (line: string) => void): void {
  const list = (title: string, items: readonly string[]): void => {
    if (items.length > 0) out([title, ...items.map((i) => `  ${i}`)].join("\n"));
  };
  list("Removed:", report.done);
  list("Already gone, not changed:", report.unchanged);
  list("LEFT IN PLACE, not as install made it (look at each, then remove it by hand if it is yours):", report.left);
  if (!report.ok) out(`Failed: ${report.failed ?? "unknown step"}. Nothing after it was touched; run the same command again once it is fixed.`);
  else if (report.left.length > 0) out("Uninstalled, except for what is listed above.");
  else out("Uninstalled. No sandbox data was touched.");
}

function parseReport(stdout: string): UninstallReport | undefined {
  try {
    const r = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Partial<UninstallReport>;
    const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof r.ok === "boolean" && strs(r.done) && strs(r.unchanged) && strs(r.left)) return r as UninstallReport;
  } catch {
    // fx-swallow-ok: no report line is reported as "no report" by the caller
  }
  return undefined;
}

export async function uninstallCommand(args: readonly string[], host: UninstallHost, out: (line: string) => void): Promise<number> {
  const unknown = args.filter((a) => a !== "--yes" && a !== "--dry-run" && a !== "--force");
  if (unknown.length > 0 || new Set(args).size !== args.length) throw new CliError(UNINSTALL_USAGE, 2);
  const yes = args.includes("--yes");
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  // The user's name only decides one line of the list; the paths are the same on every host.
  const probe = await host.facts(uninstallPlan("x").createList.filter((i) => i.target.startsWith("/")).map((i) => i.target));
  const plan = uninstallPlan(probe.runner.user);
  const actions = buildUninstallActions(plan, probe.runner);
  if (probe.existing.length === 0) {
    out("Not installed: nothing to remove.");
    return 0;
  }
  // before anything is printed or sudo is asked for: a NixOS machine, or a link on the way to a target, is refused here in one sentence
  const refusal = host.hostRefusal(actions);
  if (refusal !== undefined) throw new CliError(refusal, 2);
  out("This uninstall will remove, last made first:");
  // The ranges are in the config, which this user cannot read; the plan's own are placeholders, so they are not printed.
  const lines = renderRemoveList({ createList: plan.createList.filter((i) => i.kind !== "id-range") });
  lines.splice(1, 0, "  release          the sandbox uid and gid ranges named in the config (freed when it is removed)");
  for (const l of lines) out(l);
  out("Root steps, in order (one root call runs them; a file or directory that is not as install made it is left in place and reported):");
  actions.forEach((a, i) => out(`  ${String(i + 1).padStart(2)}. ${describeUninstall(a)}`));
  out(describeKept(await host.snapshots()));
  // Nothing below this line is root, and nothing is destroyed until both checks have passed.
  let alive: string[] | undefined;
  try {
    alive = await host.helper.list();
  } catch {
    // fx-swallow-ok: "the helper did not answer" is the state the refusal below reports
    alive = undefined;
  }
  if (alive !== undefined && alive.length > 0 && !force) {
    out(`Refused: ${plural(alive.length, "sandbox is", "sandboxes are")} still alive: ${alive.join(", ")}. Nothing was changed. Stop them first, or run this again with --force to destroy ${alive.length === 1 ? "it" : "them"} before uninstalling.`);
    return 1;
  }
  if (alive === undefined && !force) {
    out("Refused: the sandbox helper did not answer, so it is not known whether any sandbox is alive. Nothing was changed. Start the helper and run this again, or use --force to uninstall anyway.");
    return 1;
  }
  if (alive === undefined) out("The sandbox helper did not answer: live VMs may remain after this uninstall, and nothing here can destroy them.");
  else if (alive.length > 0) out(`--force: will destroy ${plural(alive.length, "live sandbox", "live sandboxes")} through the helper first: ${alive.join(", ")}.`);
  out("WARNING: stopping the helper stops every sandbox that is running now; their work is lost.");
  if (dryRun) {
    out("Dry run: no sandbox was destroyed, no root call was made and nothing was changed.");
    return 0;
  }
  // An unanswered helper makes this the one prompt that --yes does not answer: the person must say it.
  if ((alive === undefined || !yes) && !(await host.confirm("Run these steps as root now? Running sandboxes will be stopped. [y/N] "))) {
    out("Cancelled: nothing was changed.");
    return 1;
  }
  for (const id of alive ?? []) {
    try {
      await host.helper.destroy(id);
      if ((await host.helper.list()).includes(id)) throw new Error("still listed");
    } catch {
      // fx-swallow-ok: the fixed sentence below is the report
      out(`Failed: sandbox ${id} could not be destroyed (or the helper still lists it). The uninstall stopped before any root step; nothing else was changed.`);
      return 1;
    }
    out(`Destroyed sandbox ${id}; the helper no longer lists it.`);
  }
  if (alive !== undefined && alive.length > 0) {
    // One more look: a sandbox created while the loop ran must not slip through to the root steps.
    let rest: string[] | undefined;
    try {
      rest = await host.helper.list();
    } catch {
      // fx-swallow-ok: the fixed sentence below is the report
      rest = undefined;
    }
    if (rest === undefined || rest.length > 0) {
      out(`Failed: after the destroys the helper ${rest === undefined ? "did not answer" : `still lists ${rest.join(", ")}`}. The uninstall stopped before any root step; nothing else was changed.`);
      return 1;
    }
  }
  const result = await host.root.run({ version: 1, runnerUid: probe.runner.uid, runnerUser: probe.runner.user, actions });
  const report = parseReport(result.stdout);
  if (report === undefined) throw new CliError(result.code === 0 ? "the root phase gave no report" : `the root phase did not run (exit ${result.code ?? "none"}); nothing is known to have changed`);
  printReport(report, out);
  return report.ok && report.left.length === 0 ? 0 : 1;
}

/** `vm root-remove`: the root side. The request comes from standard input only; the report goes to standard output as one JSON line. */
export async function rootRemoveCommand(host: RootSideHost, out: (line: string) => void): Promise<number> {
  const text = await host.readStdin();
  if (text.length > 1 << 20) throw new CliError("root phase refused: the request is too large", 2);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a fixed sentence replaces the parser's, which would quote the input
    throw new CliError("root phase refused: the request is not JSON", 2);
  }
  const request = checkUninstallRequest(value, host.euid);
  // The runner named in the request must be the user who ran sudo, and the account database must agree on its uid.
  if (host.sudoUid !== String(request.runnerUid)) throw new CliError("root phase refused: the runner uid is not the user who ran sudo", 2);
  const who = await host.ops.run("getent", ["passwd", request.runnerUser]);
  if (who.code !== 0 || who.output.trim().split(":")[2] !== String(request.runnerUid)) throw new CliError("root phase refused: the runner user and uid do not match the account database", 2);
  const report = await applyUninstall(request, { run: host.ops.run, probe: async () => true });
  out(JSON.stringify(report));
  return report.ok && report.left.length === 0 ? 0 : 1;
}
