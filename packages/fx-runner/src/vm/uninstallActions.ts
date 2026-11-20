/**
 * The root phase of `fx-runner vm uninstall`, as data (D#587 B-2a-2 PR-4). `buildUninstallActions` walks the install plan's create list in
 * reverse (`uninstallList`) and turns each item into one removal step; nothing is listed that install did not make. The root side does
 * not trust the request: `checkUninstallRequest` rebuilds the list itself and refuses any request that differs from it, so the runner's
 * side can only ask for "the uninstall", never for a path of its choosing. This file builds and checks only; it touches no file.
 */
import { CliError } from "../cliError.js";
import type { RootAction } from "./rootActions.js";
import { HELPER_GROUP, LAYOUT, buildInstallPlan, uninstallList, type InstallPlan } from "./installPlan.js";
import { UNIT_NAME } from "./rootActions.js";
import { stateDirPath } from "./unitRender.js";

export type UninstallAction =
  | { readonly op: "stop-disable"; readonly unit: string }
  /** A file is removed only if it is a regular file with exactly this owner and mode; anything else is left and reported. */
  | { readonly op: "remove-file"; readonly path: string; readonly owner: string; readonly mode: string }
  /** `tree`: the directory holds what install (or the running helper) put in it, and goes with it, if every entry is plain and root-owned. */
  | { readonly op: "remove-dir"; readonly path: string; readonly owner: string; readonly mode: string; readonly tree?: true }
  | { readonly op: "daemon-reload" }
  | { readonly op: "remove-member"; readonly user: string; readonly group: string }
  | { readonly op: "remove-group"; readonly name: string };

export interface UninstallRequest {
  readonly version: 1;
  readonly runnerUid: number;
  readonly runnerUser: string;
  readonly actions: readonly UninstallAction[];
}

/** Directories removed with what is in them. The jail root is not one of them: it must be empty, and a sandbox's files are never swept away. */
const TREES: readonly string[] = [LAYOUT.helperDir, stateDirPath()];

/** The create list is the same whoever the host is, except for the user's name; the id ranges are not used, so any facts do. */
export function uninstallPlan(user: string): InstallPlan {
  return buildInstallPlan({ cpus: 1, memTotalKb: 4 * 1024 * 1024, smallestTemplateRamMb: 512, runner: { user, uid: 1, gid: 1 }, takenUids: [], takenGids: [] });
}

/** One step per create-list item, last made first. The id ranges are released by removing the config that records them: they are no step of their own. */
export function buildUninstallActions(plan: Pick<InstallPlan, "createList">, runner: { readonly user: string }): UninstallAction[] {
  const actions: UninstallAction[] = [];
  for (const i of uninstallList(plan)) {
    switch (i.kind) {
      case "service":
        actions.push({ op: "stop-disable", unit: UNIT_NAME });
        break;
      case "directory":
        actions.push({ op: "remove-dir", path: i.target, owner: i.owner, mode: i.mode, ...(TREES.includes(i.target) ? { tree: true as const } : {}) });
        break;
      case "file":
        actions.push({ op: "remove-file", path: i.target, owner: i.owner, mode: i.mode });
        break;
      case "unit":
        actions.push({ op: "remove-file", path: i.target, owner: i.owner, mode: i.mode }, { op: "daemon-reload" });
        break;
      case "group-member":
        actions.push({ op: "remove-member", user: runner.user, group: HELPER_GROUP });
        break;
      case "group":
        actions.push({ op: "remove-group", name: i.target });
        break;
      case "id-range":
        break;
    }
  }
  // Install's record says which of the group and the membership install made, and uninstall needs it until both are dealt with. So the record
  // and the directory that holds it go last: a run killed after the group was removed, or before, still finds the record on its re-run.
  const isRecord = (a: UninstallAction): boolean => a.op === "remove-file" && a.path === LAYOUT.recordFile;
  const isConfigDir = (a: UninstallAction): boolean => a.op === "remove-dir" && a.path === LAYOUT.configDir;
  return [...actions.filter((a) => !isRecord(a) && !isConfigDir(a)), ...actions.filter(isRecord), ...actions.filter(isConfigDir)];
}

/** The path steps as the install side's own kind of step, so the install side's link check (`hostRefusal`, `symlinkRefusal`) judges them: the same walk, the same words. */
export function uninstallPathActions(actions: readonly UninstallAction[]): RootAction[] {
  return actions.flatMap((a): RootAction[] => (a.op === "remove-file" || a.op === "remove-dir" ? [{ op: "mkdir", path: a.path, owner: a.owner, mode: a.mode }] : []));
}

/** One line per action, as the dry run and the confirmation print them. */
export function describeUninstall(a: UninstallAction): string {
  switch (a.op) {
    case "stop-disable":
      return `systemctl disable --now ${a.unit}`;
    case "remove-file":
      return `remove file ${a.path}  (only if it is ${a.owner} ${a.mode}, as install made it)`;
    case "remove-dir":
      return `remove directory ${a.path}  (only if it is ${a.owner} ${a.mode}${a.tree === true ? ", with what is in it if all of it is plain and root-owned" : " and empty"})`;
    case "daemon-reload":
      return "systemctl daemon-reload";
    case "remove-member":
      return `remove ${a.user} from group ${a.group} (if a member, and install recorded adding it)`;
    case "remove-group":
      return `remove system group ${a.name} (if present, and install recorded making it)`;
  }
}

/** What the root side checks of a request before it changes anything: root, a plain user name, and exactly the list this program would have built for that user. */
export function checkUninstallRequest(value: unknown, euid: number): UninstallRequest {
  const bad = (why: string): never => {
    throw new CliError(`root phase refused: ${why}`, 2);
  };
  if (euid !== 0) bad("it must run as root");
  const r = value as Partial<UninstallRequest> | null;
  if (r === null || typeof r !== "object" || r.version !== 1 || !Array.isArray(r.actions)) bad("not a version 1 request");
  const req = r as UninstallRequest;
  if (!Number.isInteger(req.runnerUid) || req.runnerUid <= 0 || typeof req.runnerUser !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(req.runnerUser)) bad("the runner uid must be the invoking user's, and not 0");
  if (JSON.stringify(req.actions) !== JSON.stringify(buildUninstallActions(uninstallPlan(req.runnerUser), { user: req.runnerUser }))) bad("the steps are not the uninstall list");
  return req;
}
