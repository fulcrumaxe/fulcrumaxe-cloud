/**
 * The install plan for `fx-vmhelper`: one pure object that says what a VM-mode install puts on a machine. It holds
 *   - the systemd unit text (rendered from hardening.json by ./unitRender, never restated here),
 *   - the root-owned config the helper reads (all 14 keys, with the default limits),
 *   - the create list, the single source for both install and uninstall.
 * Host facts (CPU count, MemTotal, the ids already taken, the invoking user) are injected, so nothing here reads the machine, runs
 * a program or calls sudo. The steps that act on the plan are separate rows.
 */
import { CliError } from "../cliError.js";
import { renderUnit, runtimeDirPath, stateDirPath, loadPinned, type Pinned } from "./unitRender.js";

export const HELPER_GROUP = "fx-vmhelper";
/** The lowest id a sandbox range may start at: the helper refuses a range below this (config.MinID). */
export const MIN_SANDBOX_ID = 100000;
const NOBODY = 65534;
const NO_ID = 2 ** 32 - 1;
export const MAX_SANDBOXES_CEILING = 8;
/** The bounds config.Parse enforces (config.go: max_sandboxes 1..1024, max_vcpus 1..64, max_mem_mb 1..1048576). A test reads them from that file. */
export const PARSER_BOUNDS = { max_sandboxes: 1024, max_vcpus: 64, max_mem_mb: 1 << 20 } as const;

/** Owner and mode of what the install makes. The jail root's 0711 is what the helper requires of it (sandbox.go RootMode); a test pins the number to that file. */
export const MODES = {
  jailRoot: "0711",
  /** Guest memory is secret: root-owned 0700 with no ACL, as the helper requires of snapshot_dir. */
  snapshotDir: "0700",
  /** The helper reads its config as root and refuses a file that group or others can write. */
  config: "0600",
  dir: "0755",
  unit: "0644",
} as const;

/** Where the root phase puts things. Every path is absolute, clean and root-owned. */
export const LAYOUT = {
  helperDir: "/opt/fx-vmhelper",
  helperBinary: "/opt/fx-vmhelper/bin/fx-vmhelper",
  jailerBinary: "/opt/fx-vmhelper/bin/jailer",
  firecrackerBinary: "/opt/fx-vmhelper/bin/firecracker",
  templateManifest: "/opt/fx-vmhelper/template-manifest.json",
  templateDir: "/opt/fx-vmhelper/templates",
  configDir: "/etc/fx-vmhelper",
  configFile: "/etc/fx-vmhelper/config.json",
  unitFile: "/etc/systemd/system/fx-vmhelper.service",
  jailRoot: "/var/lib/fx-vm",
  /** Outside the jail root and not holding it (config.Parse refuses otherwise); the helper stores snapshots here as root. */
  snapshotDir: "/var/lib/fx-vm-snapshots",
} as const;

export interface IdRange {
  readonly first: number;
  readonly count: number;
}

/** Everything the plan needs to know about the machine, supplied by the caller. */
export interface HostFacts {
  readonly cpus: number;
  /** MemTotal as the kernel reports it, in kB. */
  readonly memTotalKb: number;
  /** The RAM of the smallest template, in MB. */
  readonly smallestTemplateRamMb: number;
  /** The invoking user, recorded before sudo and passed on explicitly. */
  readonly runner: { readonly user: string; readonly uid: number; readonly gid: number };
  /** Ids in use or reserved: passwd, /etc/subuid and getent for uids; group, /etc/subgid and getent for gids. */
  readonly takenUids: readonly IdRange[];
  readonly takenGids: readonly IdRange[];
}

export type CreateKind = "group" | "group-member" | "directory" | "file" | "unit" | "id-range" | "service";

export interface CreateItem {
  readonly kind: CreateKind;
  readonly target: string;
  readonly detail: string;
  /** "user:group" of a path item; "-" for an item that is not a path. */
  readonly owner: string;
  /** Octal mode of a path item; "-" for an item that is not a path. */
  readonly mode: string;
  /** A group created as a system group (a low gid, outside the sandbox range). */
  readonly system?: boolean;
}

export interface Limits {
  readonly max_vcpus: number;
  readonly max_mem_mb: number;
  readonly max_sandboxes: number;
}

export interface InstallPlan {
  readonly limits: Limits;
  readonly uidRange: IdRange;
  readonly gidRange: IdRange;
  readonly unit: { readonly path: string; readonly text: string };
  readonly config: { readonly path: string; readonly text: string };
  /** In the order install makes them. Uninstall removes them in reverse (see uninstallList). */
  readonly createList: readonly CreateItem[];
}

/** The keys of the helper's config, in the order the file writes them. A test pins this list to config.go's. */
export const CONFIG_KEYS = ["jail_root", "runner_uid", "runner_gid", "uid_first", "uid_count", "gid_first", "gid_count", "max_sandboxes", "max_vcpus", "max_mem_mb", "jailer_path", "firecracker_path", "template_manifest_path", "template_dir", "snapshot_dir"] as const;

const isPosInt = (n: number): boolean => Number.isInteger(n) && n >= 1;

/** The default limits (D#587 Correction 10, Q4). They are printed at install and changed later with `fx-runner config`. */
export function defaultLimits(facts: Pick<HostFacts, "cpus" | "memTotalKb" | "smallestTemplateRamMb">): Limits {
  if (!isPosInt(facts.cpus) || !isPosInt(facts.memTotalKb) || !isPosInt(facts.smallestTemplateRamMb)) throw new CliError("install: the host facts (cpus, memory, template size) must be positive whole numbers", 2);
  const max_mem_mb = Math.floor((facts.memTotalKb * 3) / 4 / 1024);
  const max_sandboxes = Math.min(MAX_SANDBOXES_CEILING, Math.floor(max_mem_mb / facts.smallestTemplateRamMb));
  if (max_sandboxes < 1) throw new CliError("install: this machine has too little memory for one sandbox", 2);
  // The helper refuses a config above its bounds, so a very large host is clamped to them (the per-sandbox ceilings).
  return { max_vcpus: Math.min(facts.cpus, PARSER_BOUNDS.max_vcpus), max_mem_mb: Math.min(max_mem_mb, PARSER_BOUNDS.max_mem_mb), max_sandboxes: Math.min(max_sandboxes, PARSER_BOUNDS.max_sandboxes) };
}

/** The first block of `count` ids at or above `floor` that overlaps none of `taken`. */
export function firstFreeBlock(taken: readonly IdRange[], count: number, floor: number = MIN_SANDBOX_ID): IdRange {
  const used = taken.filter((r) => r.count > 0).sort((a, b) => a.first - b.first);
  let first = floor;
  for (const r of used) {
    if (r.first + r.count <= first) continue;
    if (r.first >= first + count) break;
    first = r.first + r.count;
  }
  if (first + count > NO_ID || (first <= NOBODY && NOBODY < first + count)) throw new CliError("install: no free id block is left for the sandboxes", 2);
  return { first, count };
}

/** The value of the root-owned config, with every key present. */
function configValues(facts: HostFacts, limits: Limits, uid: IdRange, gid: IdRange): Record<(typeof CONFIG_KEYS)[number], string | number> {
  return {
    jail_root: LAYOUT.jailRoot,
    runner_uid: facts.runner.uid,
    runner_gid: facts.runner.gid,
    uid_first: uid.first,
    uid_count: uid.count,
    gid_first: gid.first,
    gid_count: gid.count,
    max_sandboxes: limits.max_sandboxes,
    max_vcpus: limits.max_vcpus,
    max_mem_mb: limits.max_mem_mb,
    jailer_path: LAYOUT.jailerBinary,
    firecracker_path: LAYOUT.firecrackerBinary,
    template_manifest_path: LAYOUT.templateManifest,
    template_dir: LAYOUT.templateDir,
    snapshot_dir: LAYOUT.snapshotDir,
  };
}

/** The plan for one install. It throws a CliError (exit 2) and returns nothing when the facts are unusable. */
export function buildInstallPlan(facts: HostFacts, pinned: Pinned = loadPinned()): InstallPlan {
  const { user, uid, gid } = facts.runner;
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) throw new CliError("install: the runner uid and gid must be the invoking user's, and not 0", 2);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new CliError("install: the runner user name is not a plain account name", 2);
  const limits = defaultLimits(facts);
  const uidRange = firstFreeBlock([...facts.takenUids, { first: uid, count: 1 }], limits.max_sandboxes);
  const gidRange = firstFreeBlock([...facts.takenGids, { first: gid, count: 1 }], limits.max_sandboxes);
  const unitText = renderUnit({ helperPath: LAYOUT.helperBinary, configPath: LAYOUT.configFile, jailRoot: LAYOUT.jailRoot, snapshotDir: LAYOUT.snapshotDir, group: HELPER_GROUP }, pinned);
  const configText = `${JSON.stringify(configValues(facts, limits, uidRange, gidRange), null, 2)}\n`;
  const range = (r: IdRange): string => `${r.first}-${r.first + r.count - 1}`;
  const root = "root:root";
  const none = { owner: "-", mode: "-" } as const;
  const createList: CreateItem[] = [
    { kind: "group", target: HELPER_GROUP, detail: "system group; owns the helper's socket directory", ...none, system: true },
    { kind: "group-member", target: `${user} in ${HELPER_GROUP}`, detail: "the runner's user may connect; a re-login activates it", ...none },
    { kind: "directory", target: LAYOUT.helperDir, detail: "the helper, the jailer, the VMM, the template manifest and the templates", owner: root, mode: MODES.dir },
    { kind: "directory", target: LAYOUT.configDir, detail: "the helper's config", owner: root, mode: MODES.dir },
    { kind: "file", target: LAYOUT.configFile, detail: `the helper's config; limits: ${limits.max_sandboxes} sandboxes, ${limits.max_vcpus} vCPUs, ${limits.max_mem_mb} MB`, owner: root, mode: MODES.config },
    { kind: "unit", target: LAYOUT.unitFile, detail: "the hardened systemd unit", owner: root, mode: MODES.unit },
    { kind: "directory", target: LAYOUT.jailRoot, detail: "the one jail root", owner: root, mode: MODES.jailRoot },
    { kind: "directory", target: LAYOUT.snapshotDir, detail: "where snapshots are stored: guest memory, root only", owner: root, mode: MODES.snapshotDir },
    { kind: "directory", target: stateDirPath(pinned), detail: "the unit's state directory, made by systemd at first start", owner: root, mode: pinned.state_directory_mode },
    { kind: "directory", target: runtimeDirPath(pinned), detail: "the socket directory, made by systemd at each start", owner: `root:${HELPER_GROUP}`, mode: pinned.runtime_directory_mode },
    { kind: "id-range", target: `uid ${range(uidRange)}`, detail: "sandbox users, taken from the first free block; released on uninstall", ...none },
    { kind: "id-range", target: `gid ${range(gidRange)}`, detail: "sandbox groups, taken from the first free block; released on uninstall", ...none },
    { kind: "service", target: "fx-vmhelper.service", detail: "enabled and started", ...none },
  ];
  return { limits, uidRange, gidRange, unit: { path: LAYOUT.unitFile, text: unitText }, config: { path: LAYOUT.configFile, text: configText }, createList };
}

/** Uninstall removes exactly the create list, last made first. */
export function uninstallList(plan: Pick<InstallPlan, "createList">): readonly CreateItem[] {
  return [...plan.createList].reverse();
}

const UNINSTALL_VERB: Readonly<Record<CreateKind, string>> = {
  group: "remove group",
  "group-member": "remove member",
  directory: "remove directory",
  file: "remove file",
  unit: "remove unit",
  "id-range": "release",
  service: "stop and disable",
};

const meta = (i: CreateItem): string => (i.mode === "-" ? "" : `  ${i.owner} ${i.mode}`);

/** The lines install prints, before the password prompt, for the list it is about to make. */
export function renderCreateList(items: readonly CreateItem[]): string[] {
  return items.map((i) => `  ${i.kind.padEnd(12)} ${i.target}${meta(i)}  (${i.detail})`);
}

/** The lines uninstall prints for the same list. */
export function renderRemoveList(plan: Pick<InstallPlan, "createList">): string[] {
  return uninstallList(plan).map((i) => `  ${UNINSTALL_VERB[i.kind].padEnd(16)} ${i.target}${meta(i)}`);
}
