/**
 * The root phase of a VM-mode install, as data (D#587 B-2a-2 PR-3). `buildRootActions` turns the install plan's create list and the staged
 * bundle into ONE explicit list of steps; the dry run prints it, the single root call carries it, and the root side applies it and, on a
 * failure, undoes it in reverse order from the same list. This file only builds and checks the list: it touches no file and starts no program.
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import type { StagedBundle, StagedFile } from "./bundle.js";
import { HELPER_GROUP, LAYOUT, MODES, type InstallPlan } from "./installPlan.js";
import { socketPath } from "./unitRender.js";

export const UNIT_NAME = "fx-vmhelper.service";

export type RootAction =
  | { readonly op: "group"; readonly name: string }
  | { readonly op: "member"; readonly user: string; readonly group: string }
  | { readonly op: "mkdir"; readonly path: string; readonly owner: string; readonly mode: string }
  /** `source` is a staged file (read by no-follow open, as the runner's user); `text` is content carried in the request. */
  | { readonly op: "install"; readonly path: string; readonly owner: string; readonly mode: string; readonly sha256: string; readonly length: number; readonly source?: string; readonly text?: string; readonly restarts?: true; /** The unit file: systemd must reload after it changes. */ readonly reloads?: true }
  | { readonly op: "daemon-reload" }
  | { readonly op: "enable-start"; readonly unit: string }
  /** Only when this run changed the helper, its config or its unit and the service was already running: an upgrade must not leave the old program running. */
  | { readonly op: "restart"; readonly unit: string }
  | { readonly op: "probe"; readonly socket: string };

export interface RootRequest {
  readonly version: 1;
  /** The invoking user's uid, recorded before sudo: the root side reads staged files only if this user owns them. */
  readonly runnerUid: number;
  readonly runnerUser: string;
  readonly actions: readonly RootAction[];
}

export const ROOT_OWNER = "root:root";
const sha256Hex = /^[0-9a-f]{64}$/;

/** The one list of root steps. Order: group and membership, directories, files, then the service. */
export function buildRootActions(plan: InstallPlan, staged: StagedBundle, runner: { readonly user: string }, sha256Of: (text: string) => string): RootAction[] {
  const actions: RootAction[] = [{ op: "group", name: HELPER_GROUP }, { op: "member", user: runner.user, group: HELPER_GROUP }];
  // The state and socket directories are made by systemd at each start (the unit's StateDirectory and RuntimeDirectory), and the id ranges
  // are recorded in the config: neither is a root step of its own.
  const dirs = plan.createList.filter((i) => i.kind === "directory" && Object.values(LAYOUT).includes(i.target as never));
  const staging = [...Object.values(staged.binaries), ...Object.values(staged.templates).flatMap((t) => Object.values(t))];
  const listed = new Set(dirs.map((i) => i.target));
  const extra = new Set<string>();
  for (const f of staging) for (let d = path.posix.dirname(f.dest); d !== LAYOUT.helperDir && !listed.has(d); d = path.posix.dirname(d)) extra.add(d);
  // destination directories below the helper's own (bin, templates, templates/<id>), shortest first so each parent exists before its child
  const below: RootAction[] = [...extra].sort((x, y) => x.length - y.length).map((d) => ({ op: "mkdir", path: d, owner: ROOT_OWNER, mode: "0755" }));
  for (const i of dirs) {
    actions.push({ op: "mkdir", path: i.target, owner: i.owner, mode: i.mode });
    if (i.target === LAYOUT.helperDir) actions.push(...below);
  }
  const fromStaged = (f: StagedFile, mode: string, restarts?: true): RootAction => ({ op: "install", path: f.dest, owner: ROOT_OWNER, mode, sha256: f.sha256, length: f.length, source: f.file, ...(restarts === undefined ? {} : { restarts }) });
  for (const f of Object.values(staged.binaries)) actions.push(fromStaged(f, "0755", true));
  actions.push({ op: "install", path: staged.manifest.dest, owner: ROOT_OWNER, mode: "0644", sha256: sha256Of(staged.manifest.text), length: Buffer.byteLength(staged.manifest.text), text: staged.manifest.text });
  for (const t of Object.values(staged.templates)) for (const f of Object.values(t)) actions.push(fromStaged(f, "0644"));
  for (const item of plan.createList.filter((i) => i.kind === "file" || i.kind === "unit")) {
    const text = item.kind === "unit" ? plan.unit.text : plan.config.text;
    actions.push({ op: "install", path: item.target, owner: item.owner, mode: item.mode, sha256: sha256Of(text), length: Buffer.byteLength(text), text, restarts: true, ...(item.kind === "unit" ? { reloads: true as const } : {}) });
  }
  actions.push({ op: "daemon-reload" }, { op: "enable-start", unit: UNIT_NAME }, { op: "restart", unit: UNIT_NAME }, { op: "probe", socket: socketPath() });
  return actions;
}

/** One line per action, as the dry run and the confirmation print them. */
export function describeAction(a: RootAction): string {
  switch (a.op) {
    case "group":
      return `create system group ${a.name} (if absent)`;
    case "member":
      return `add ${a.user} to group ${a.group} (if not a member)`;
    case "mkdir":
      return `make directory ${a.path}  ${a.owner} ${a.mode}`;
    case "install":
      return `install ${a.path}  ${a.owner} ${a.mode}  sha256 ${a.sha256.slice(0, 12)}  (${a.length} bytes, via a temp file, fsync, rename, then checked)`;
    case "daemon-reload":
      return "systemctl daemon-reload";
    case "restart":
      return `systemctl restart ${a.unit} (only if this run changed the helper, its config or its unit and it was already running)`;
    case "enable-start":
      return `systemctl enable --now ${a.unit}`;
    case "probe":
      return `check the helper answers on ${a.socket}`;
  }
}

const abs = (p: string): boolean => typeof p === "string" && p.startsWith("/") && !p.includes("\0") && path.posix.normalize(p) === p && p !== "/";
const OWNER = /^[a-z_][a-z0-9_-]{0,31}:[a-z_][a-z0-9_-]{0,31}$/;
const MODE = /^0[0-7]{3}$/;
const TEMPLATE_ID = "[a-z][a-z0-9-]{0,30}";
const DIR_PLACES: readonly string[] = [LAYOUT.helperDir, `${LAYOUT.helperDir}/bin`, LAYOUT.templateDir, LAYOUT.configDir, LAYOUT.jailRoot, LAYOUT.snapshotDir];
const FILE_PLACES: readonly string[] = [LAYOUT.helperBinary, LAYOUT.jailerBinary, LAYOUT.firecrackerBinary, LAYOUT.templateManifest, LAYOUT.configFile, LAYOUT.unitFile];
const TEMPLATE_DIR = new RegExp(`^${LAYOUT.templateDir}/${TEMPLATE_ID}$`);
const TEMPLATE_FILE = new RegExp(`^${LAYOUT.templateDir}/${TEMPLATE_ID}/(kernel|rootfs)$`);

/** What the root side checks of a request before it changes anything. Every path is absolute and inside the install's own places. */
export function checkRequest(value: unknown, euid: number): RootRequest {
  const bad = (why: string): never => {
    throw new CliError(`root phase refused: ${why}`, 2);
  };
  if (euid !== 0) bad("it must run as root");
  const r = value as Partial<RootRequest> | null;
  if (r === null || typeof r !== "object" || r.version !== 1 || !Array.isArray(r.actions) || r.actions.length === 0 || r.actions.length > 64) bad("not a version 1 request");
  const req = r as RootRequest;
  if (!Number.isInteger(req.runnerUid) || req.runnerUid <= 0 || typeof req.runnerUser !== "string") bad("the runner uid must be the invoking user's, and not 0");
  for (const a of req.actions) {
    // exactly the places this install makes, not "anything below" them
    if (a.op === "mkdir" && !(abs(a.path) && (DIR_PLACES.includes(a.path) || TEMPLATE_DIR.test(a.path)))) bad("a directory is not one of the install's own places");
    if (a.op === "install" && !(abs(a.path) && (FILE_PLACES.includes(a.path) || TEMPLATE_FILE.test(a.path)))) bad("a file is not one of the install's own places");
    if (a.op === "mkdir" || a.op === "install") {
      // four-digit modes (setuid, setgid, sticky) never match
      if (a.owner !== ROOT_OWNER || !OWNER.test(a.owner) || !MODE.test(a.mode)) bad("an owner or mode is not root:root with a plain 0nnn mode");
      // guest memory is stored here: this one place is exactly root:root 0700, whatever plain mode another place is allowed
      if (a.op === "mkdir" && a.path === LAYOUT.snapshotDir && (a.owner !== ROOT_OWNER || a.mode !== MODES.snapshotDir)) bad("the snapshot directory must be root:root 0700");
    }
    if (a.op === "install") {
      if (!sha256Hex.test(a.sha256) || !Number.isInteger(a.length) || a.length < 0 || (a.source === undefined) === (a.text === undefined) || (a.restarts !== undefined && a.restarts !== true) || (a.reloads !== undefined && (a.reloads !== true || a.path !== LAYOUT.unitFile))) bad("an install step is malformed");
      if (a.source !== undefined && !abs(a.source)) bad("a source path is not absolute");
    }
    if (a.op === "group" && a.name !== HELPER_GROUP) bad("only the helper's group may be created");
    if (a.op === "member" && (a.group !== HELPER_GROUP || a.user !== req.runnerUser)) bad("only the runner's user may join the helper's group");
    if ((a.op === "enable-start" || a.op === "restart") && a.unit !== UNIT_NAME) bad("only the helper's unit may be started");
    if (a.op === "probe" && a.socket !== socketPath()) bad("only the helper's socket may be probed");
    if (!["group", "member", "mkdir", "install", "daemon-reload", "enable-start", "restart", "probe"].includes(a.op)) bad("an unknown step");
  }
  return req;
}
