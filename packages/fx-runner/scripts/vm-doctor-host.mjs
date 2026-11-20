// The real machine behind the VM install checks of `fx-runner doctor` (src/vm/doctorChecks.ts, `VmInstallFacts`). It reads only what the runner's own
// user can read: no sudo, no root call. A fact it could not read comes back as "unreadable" with the reason (an error code, never a path or message),
// never as a pass. It lives here, not in src/, because src/ never starts a process or reads `process` (test/prompt.test.ts, test/cleanEnv.test.ts).
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { hostArch, selectTargets } from "../src/vm/bundle.js";
import { probeHelper } from "../src/vm/helperProbe.js";
import { LAYOUT, HELPER_GROUP } from "../src/vm/installPlan.js";
import { UNIT_NAME } from "../src/vm/rootActions.js";
import { createHash } from "node:crypto";
import { socketPath } from "../src/vm/unitRender.js";

const ENV = { PATH: process.env.PATH ?? "", LC_ALL: "C" };
const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { env: ENV, encoding: "utf8", timeout: 5000, maxBuffer: 1 << 20 }, (error, stdout) => resolve({ code: error === null ? 0 : (typeof error.code === "number" ? error.code : -1), stdout }));
  });

const gone = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";
const unreadable = (e) => ({ state: "unreadable", why: typeof e?.code === "string" ? e.code : "error" });

function look(file) {
  try {
    const st = lstatSync(file);
    return { state: "ok", value: { kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other", uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 } };
  } catch (e) {
    return gone(e) ? { state: "absent" } : unreadable(e);
  }
}

/** `/dev/kvm`: "present" only when it is a character device this user can read and write; "unreadable" for anything else but a plain not-found. */
function kvm() {
  try {
    if (!lstatSync("/dev/kvm").isCharacterDevice()) return "unreadable";
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return "present";
  } catch (e) {
    return gone(e) ? "absent" : "unreadable";
  }
}

async function unit() {
  const r = await run("systemctl", ["show", "--property=LoadState,ActiveState", UNIT_NAME]);
  if (r.code !== 0) return "unknown";
  const load = /^LoadState=(.*)$/m.exec(r.stdout)?.[1];
  const active = /^ActiveState=(.*)$/m.exec(r.stdout)?.[1];
  if (load === "not-found") return "absent";
  return active === "active" ? "active" : active === "failed" ? "failed" : active === "inactive" || active === "activating" || active === "deactivating" ? "inactive" : "unknown";
}

async function socket() {
  const file = socketPath();
  try {
    lstatSync(file);
    accessSync(file, constants.R_OK | constants.W_OK);
  } catch (e) {
    return gone(e) ? "absent" : "unreadable";
  }
  return (await probeHelper(file, { attempts: 1 })) ? "answers" : "silent";
}

function binary() {
  try {
    return { state: "ok", value: createHash("sha256").update(readFileSync(LAYOUT.helperBinary)).digest("hex") };
  } catch (e) {
    return gone(e) ? { state: "absent" } : unreadable(e);
  }
}

async function signed(tuf, nodeArch) {
  try {
    const listed = await tuf.listTargets();
    if (!listed.ok) return { state: "unreadable", why: "the release metadata could not be fetched and verified" };
    return { state: "ok", value: selectTargets(listed.paths, hostArch(nodeArch)).binaries.vmhelper.sha256 };
  } catch {
    // fx-swallow-ok: the reason shown is fixed text; the error may carry an address
    return { state: "unreadable", why: "the release metadata does not list this machine's helper" };
  }
}

async function group() {
  const user = userInfo().username;
  const r = await run("getent", ["group", HELPER_GROUP]);
  if (r.code === 2) return { user, exists: false, member: false, active: false };
  const f = r.stdout.trim().split(":");
  const gid = Number(f[2]);
  if (r.code !== 0 || !Number.isInteger(gid)) return { user, exists: undefined, member: undefined, active: undefined };
  const groups = [process.getegid?.(), ...(process.getgroups?.() ?? [])];
  return { user, exists: true, member: (f[3] ?? "").split(",").includes(user), active: groups.includes(gid) };
}

/** @param {{ tuf: { listTargets(): Promise<{ ok: boolean, paths?: string[] }> } }} deps */
export function createVmInstallFacts(deps) {
  return async () => {
    const [u, s, sig, g] = await Promise.all([unit(), socket(), signed(deps.tuf, process.arch), group()]);
    return { unit: u, socket: s, binary: binary(), signed: sig, config: look(LAYOUT.configFile), jailRoot: look(LAYOUT.jailRoot), group: g, kvm: kvm() };
  };
}
