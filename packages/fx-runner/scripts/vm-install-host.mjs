// The real machine behind `fx-runner vm install` (src/vm/install.ts, `InstallHost` and `RootSideHost`): it reads the host facts, starts the ONE
// root call (sudo, a fixed argument list, no shell) and, on the root side, starts the account and service programs by name. It lives here, not in
// src/, because src/ never starts a process or reads `process` (test/prompt.test.ts, test/cleanEnv.test.ts). bin/fx-runner.mjs hands it to the CLI.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, userInfo } from "node:os";

const SUDO_PLACES = ["/run/wrappers/bin/sudo", "/usr/bin/sudo", "/bin/sudo"];
const MAX_STDIN = 1 << 20;
/** The root side starts programs with exactly this PATH and no other variable: nothing inherited, so no LD_* and no caller-chosen search path (CWE-426). */
export const ROOT_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const runFixed = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { env: { PATH: ROOT_PATH }, encoding: "utf8", maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, output: `${stdout}${stderr}` });
    });
  });

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const getent = (db) =>
  new Promise((resolve) => {
    execFile("getent", [db], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", maxBuffer: 64 << 20 }, (error, stdout) => resolve(error === null ? stdout : ""));
  });

/** One `{first, count}` per line of `name:x:id:...` (passwd, group) or `name:first:count` (subuid, subgid). */
const idRanges = (text, sub) =>
  text
    .split("\n")
    .map((l) => l.split(":"))
    .flatMap((f) => (sub ? [{ first: Number(f[1]), count: Number(f[2]) }] : [{ first: Number(f[2]), count: 1 }]))
    .filter((r) => Number.isInteger(r.first) && Number.isInteger(r.count) && r.count > 0);

/** @param {{ selfCommand: string[], tuf: unknown, confirm: (q: string) => Promise<boolean>, buildRootArgv: Function, hostRefusal: Function }} deps (the two functions come from src/vm, handed in by bin/fx-runner.mjs) */
export function createVmInstallHosts(deps) {
  const install = {
    nodeArch: process.arch,
    tuf: deps.tuf,
    confirm: deps.confirm,
    hostRefusal: deps.hostRefusal,
    facts: async () => {
      const mem = /^MemTotal:\s+(\d+) kB/m.exec(read("/proc/meminfo"));
      const [pw, gr] = await Promise.all([getent("passwd"), getent("group")]);
      return {
        cpus: cpus().length,
        memTotalKb: mem === null ? 0 : Number(mem[1]),
        // the invoking user, recorded here before sudo and passed on explicitly
        runner: { user: userInfo().username, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
        takenUids: [...idRanges(read("/etc/passwd"), false), ...idRanges(pw, false), ...idRanges(read("/etc/subuid"), true)],
        takenGids: [...idRanges(read("/etc/group"), false), ...idRanges(gr, false), ...idRanges(read("/etc/subgid"), true)],
      };
    },
    root: {
      run: (request) =>
        new Promise((resolve, reject) => {
          const sudo = SUDO_PLACES.find((p) => existsSync(p));
          if (sudo === undefined) return reject(new Error("sudo was not found on this machine"));
          const [file, ...args] = deps.buildRootArgv(sudo, deps.selfCommand);
          const child = spawn(file, args, { env: { PATH: process.env.PATH ?? "" }, shell: false, stdio: ["pipe", "pipe", "inherit"] });
          let stdout = "";
          child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout }));
          child.stdin.end(JSON.stringify(request));
        }),
    },
  };
  const root = {
    euid: process.geteuid?.() ?? -1,
    sudoUid: process.env.SUDO_UID,
    readStdin: () =>
      new Promise((resolve, reject) => {
        let text = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (d) => {
          text += d;
          if (text.length > MAX_STDIN) reject(new Error("the request is too large"));
        });
        process.stdin.on("end", () => resolve(text));
        process.stdin.on("error", reject);
      }),
    ops: { run: runFixed },
  };
  return { install, root };
}
