/**
 * The VM-helper install checks of `fx-runner doctor` (D#587 B-2a-2 PR-4). Pure: the machine's answers arrive as `VmInstallFacts`, read at the
 * bin edge as the runner's own user and never through root, so a test hands in facts and nothing here touches the machine. Each check is its own
 * PASS, WARN or FAIL line with the fix in plain words. A fact the runner's user could not read is a WARN that says why, never a PASS.
 */
import { HELPER_GROUP, LAYOUT, MODES } from "./installPlan.js";
import { UNIT_NAME } from "./rootActions.js";

/** Whether a device or socket is there for this user to use: "unreadable" is anything but a plain yes or no. */
export type Presence = "present" | "absent" | "unreadable";

/** A look at one thing: not there, there but not readable by this user (with the reason), or read. */
export type Look<T> = { readonly state: "absent" } | { readonly state: "unreadable"; readonly why: string } | { readonly state: "ok"; readonly value: T };
export interface PathMeta {
  readonly kind: "file" | "dir" | "other";
  readonly uid: number;
  readonly gid: number;
  /** Permission bits only (`st.mode & 0o7777`). */
  readonly mode: number;
}

export interface VmInstallFacts {
  /** What `systemctl is-active` says, or "absent" when the unit file is missing, or "unknown" when systemd could not be asked. */
  readonly unit: "active" | "inactive" | "failed" | "absent" | "unknown";
  /** The helper's own protocol answer on its socket. */
  readonly socket: "answers" | "silent" | "absent" | "unreadable";
  /** sha256 of the installed helper binary. */
  readonly binary: Look<string>;
  /** The digest the signed release record gives for this machine's architecture. */
  readonly signed: Look<string>;
  readonly config: Look<PathMeta>;
  readonly jailRoot: Look<PathMeta>;
  /** `undefined` where the group database could not be read. `active`: this session already holds the group. */
  readonly group: { readonly user: string; readonly exists: boolean | undefined; readonly member: boolean | undefined; readonly active: boolean | undefined };
  readonly kvm: Presence;
}

export interface VmCheck {
  readonly level: "PASS" | "WARN" | "FAIL" | "INFO";
  readonly label: string;
  readonly detail: string;
}

const octal = (n: number): string => n.toString(8).padStart(4, "0");
const rootOwned = (m: PathMeta): boolean => m.uid === 0 && m.gid === 0;

/** Owner and mode of a file or directory install makes, against the numbers the install plan uses. */
function metaCheck(label: string, what: string, path: string, look: Look<PathMeta>, kind: "file" | "dir", mode: string, why: string, fix: string): VmCheck {
  if (look.state === "absent") return { level: "FAIL", label, detail: `${what} ${path} is missing; ${fix}` };
  if (look.state === "unreadable") return { level: "WARN", label, detail: `${path} could not be examined by this user (${look.why}), so its owner and mode were not checked` };
  const m = look.value;
  if (m.kind === kind && rootOwned(m) && m.mode === parseInt(mode, 8)) return { level: "PASS", label, detail: `${path} is root-owned, mode ${mode}` };
  return { level: "FAIL", label, detail: `${path} is ${m.kind === kind ? "" : `not a ${kind === "dir" ? "directory" : "plain file"}, and is `}owned by uid ${m.uid} gid ${m.gid}, mode ${octal(m.mode)}; ${why}. Fix: ${fix}` };
}

/** True when nothing of the install is there at all: then VM mode was never set up, which is not a fault. */
function nothingInstalled(f: VmInstallFacts): boolean {
  return f.unit === "absent" && f.config.state === "absent" && f.binary.state === "absent" && f.group.exists === false;
}

export function vmInstallChecks(f: VmInstallFacts): VmCheck[] {
  if (nothingInstalled(f)) return [{ level: "INFO", label: "VM helper", detail: "not installed. VM mode is optional; to use it, run: fx-runner vm install" }];
  const out: VmCheck[] = [];
  const reinstall = "run: fx-runner vm install";
  const unitLabel = "VM unit";
  if (f.unit === "active") out.push({ level: "PASS", label: unitLabel, detail: `${UNIT_NAME} is installed and running` });
  else if (f.unit === "absent") out.push({ level: "FAIL", label: unitLabel, detail: `${UNIT_NAME} is not installed; ${reinstall}` });
  else if (f.unit === "unknown") out.push({ level: "WARN", label: unitLabel, detail: "systemd could not be asked whether the helper's unit is running" });
  else out.push({ level: "FAIL", label: unitLabel, detail: `${UNIT_NAME} is ${f.unit}. Start it with: sudo systemctl restart ${UNIT_NAME}; if it stops again, read: journalctl -u ${UNIT_NAME}` });

  const helperLabel = "VM helper";
  if (f.socket === "answers") out.push({ level: "PASS", label: helperLabel, detail: "answers on its socket" });
  else if (f.socket === "unreadable") out.push({ level: "WARN", label: helperLabel, detail: `its socket could not be reached by this user, so it was not asked; this is expected until you are in the group ${HELPER_GROUP} and have logged in again` });
  else if (f.socket === "absent") out.push({ level: "FAIL", label: helperLabel, detail: `no socket: the helper is not running. Start it with: sudo systemctl restart ${UNIT_NAME}` });
  else out.push({ level: "FAIL", label: helperLabel, detail: `its socket does not answer. Restart it with: sudo systemctl restart ${UNIT_NAME}` });

  const binLabel = "VM binary";
  if (f.binary.state === "absent") out.push({ level: "FAIL", label: binLabel, detail: `${LAYOUT.helperBinary} is missing; ${reinstall}` });
  else if (f.binary.state === "unreadable") out.push({ level: "WARN", label: binLabel, detail: `${LAYOUT.helperBinary} could not be read by this user (${f.binary.why}), so it was not compared with the signed record` });
  else if (f.signed.state !== "ok") out.push({ level: "WARN", label: binLabel, detail: `the signed release record could not be read${f.signed.state === "unreadable" ? ` (${f.signed.why})` : ""}, so the installed program was not compared with it` });
  else if (f.binary.value === f.signed.value) out.push({ level: "PASS", label: binLabel, detail: `${LAYOUT.helperBinary} matches the signed record (sha256 ${f.binary.value.slice(0, 12)})` });
  else out.push({ level: "FAIL", label: binLabel, detail: `${LAYOUT.helperBinary} does not match the signed record (installed ${f.binary.value.slice(0, 12)}, signed ${f.signed.value.slice(0, 12)}); replace it with: fx-runner vm install` });

  out.push(metaCheck("VM config", "the helper's config", LAYOUT.configFile, f.config, "file", MODES.config, "the helper refuses a config that anyone but root owns or can write", `sudo chown root:root ${LAYOUT.configFile} && sudo chmod ${MODES.config.slice(1)} ${LAYOUT.configFile}`));
  out.push(metaCheck("VM jail root", "the jail root", LAYOUT.jailRoot, f.jailRoot, "dir", MODES.jailRoot, "the helper needs it to be root's, and 0711 so sandbox users can pass through but not list it", `sudo chown root:root ${LAYOUT.jailRoot} && sudo chmod ${MODES.jailRoot.slice(1)} ${LAYOUT.jailRoot}`));

  const g = f.group;
  const groupLabel = "VM group";
  if (g.exists === undefined || g.member === undefined) out.push({ level: "WARN", label: groupLabel, detail: `the group database could not be read, so ${g.user}'s place in ${HELPER_GROUP} was not checked` });
  else if (!g.exists) out.push({ level: "FAIL", label: groupLabel, detail: `the group ${HELPER_GROUP} does not exist; ${reinstall}` });
  else if (!g.member) out.push({ level: "FAIL", label: groupLabel, detail: `${g.user} is not in the group ${HELPER_GROUP}. Add yourself with: sudo usermod -aG ${HELPER_GROUP} ${g.user}, then log out and in again` });
  else if (g.active === false) out.push({ level: "WARN", label: groupLabel, detail: `vm helper installed, re-login needed: ${g.user} was added to ${HELPER_GROUP}, but this session does not have the group yet. Log out and in again` });
  else out.push({ level: "PASS", label: groupLabel, detail: `${g.user} is in the group ${HELPER_GROUP}` });

  const kvmLabel = "VM KVM";
  if (f.kvm === "present") out.push({ level: "PASS", label: kvmLabel, detail: "/dev/kvm is there and this user can use it" });
  else if (f.kvm === "absent") out.push({ level: "FAIL", label: kvmLabel, detail: "/dev/kvm does not exist: this machine cannot run VMs. Turn on virtualization in the firmware settings, or use the default sandbox" });
  else out.push({ level: "WARN", label: kvmLabel, detail: "/dev/kvm exists but this user cannot read and write it, or it could not be examined. Add yourself to the kvm group (sudo usermod -aG kvm <you>) and log in again" });
  return out;
}
