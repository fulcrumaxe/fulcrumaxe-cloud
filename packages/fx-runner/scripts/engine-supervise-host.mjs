// The real machine behind `fx-engine-supervisor` (src/engineHost/guestSession.ts, D#845 ON-13b1): starts the engine host, counts what is left of its process group and listens on the channel socket. It lives here, not in
// src/, because src/ never starts a process (test/prompt.test.ts). Two programs call `runEngineSupervise`: the microVM's `infra/microvm-image/guest/engine-supervisor.entry.mjs` (bundled into the image) and the
// runner's own hidden `__engine-supervise` (bin/fx-runner.mjs), which the standard tier holds in an engine session's unit. Neither has systemd to ask: the VM or the unit is the boundary, and the kill path is the host's process group.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createGuestSession, CHANNEL_SOCKET, SESSION_READY_LINE } from "../src/engineHost/guestSession.ts";

const statFields = (pid) => {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
};
/** How many processes are still in the process group `pgid` (counted in the process table; a process that left the group is not found, which the VM or the unit still ends). */
export const groupMembers = (pgid) => readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name) && Number(statFields(name)?.[2]) === pgid).length;
/** The longest the exit waits for open channel connections to close. */
export const CLOSE_WAIT_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // fx-swallow-ok: a group that is already gone is the wanted state
  }
};

/** @returns {import("../src/engineHost/guestSession.ts").GuestRuntime} */
export function guestRuntime({ claudePath, env }) {
  return {
    uid: process.getuid?.() ?? -1,
    ownPid: process.pid,
    claudePath,
    env,
    launch: (spec) => {
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => undefined); // the host may exit before it has read everything
      child.on("error", () => undefined); // a start that failed has no pid; the supervisor counts it as a crash
      return {
        pid: child.pid,
        write: (text) => void child.stdin.write(text),
        closeStdin: () => child.stdin.end(),
        onStdout: (cb) => child.stdout.on("data", cb),
        onStderr: (cb) => child.stderr.on("data", cb),
        // `close`, not `exit`: it comes after the output streams have ended, so no output can arrive after the supervisor has flushed its redaction tail
        onExit: (cb) => child.on("close", () => cb()),
      };
    },
    isAlive: (pid) => {
      try {
        return process.kill(pid, 0);
      } catch {
        return false;
      }
    },
    startOf: (pid) => statFields(pid)?.[19],
    killHost: async (handle) => {
      signalGroup(handle.pid, "SIGTERM");
      await sleep(1000);
      signalGroup(handle.pid, "SIGKILL");
      await sleep(200);
      return { survivors: groupMembers(handle.pid) };
    },
    killScope: async () => undefined,
    now: () => Date.now(),
    after: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
}

/**
 * The program EXITS after a channel `stop` has been answered and after the supervisor ends on its own (`crash_loop`), as well as on a signal: Node cannot zero the strings and environment copies a launch makes of the credential,
 * so the bridge kills the group, `init_on_free=1` zeroes the pages and init starts a fresh supervisor with none. Disk-side checks alone are not enough.
 * `tune` (tests) may replace parts of the runtime, such as the clock and the timers.
 * Runs the supervisor until then: the state directory (0700, made when missing) holds the log, the spool, the handle and `session.json`; the channel socket is `socket` or `<dir>/channel.sock`.
 * Prints `SESSION_READY_LINE` once it listens. A SIGTERM is a `machine_shutdown` stop (the credential is wiped, then the host ends).
 */
export async function runEngineSupervise({ dir, claudePath, env, socket, out = (line) => process.stdout.write(`${line}\n`), tune = (runtime) => runtime }) {
  const session = createGuestSession({ dir, runtime: tune(guestRuntime({ claudePath, env })) });
  const listening = await session.serve(socket ?? path.join(dir, CHANNEL_SOCKET));
  out(SESSION_READY_LINE);
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  let onSignal = () => undefined;
  const end = new Promise((resolve) => {
    onSignal = () => resolve(undefined);
    for (const signal of signals) process.once(signal, onSignal);
  });
  await Promise.race([end, session.finished()]);
  for (const signal of signals) process.off(signal, onSignal);
  await session.request({ op: "stop", reason: "machine_shutdown" }); // idempotent after a stop or a crash_loop: wipes again and ends the host
  await Promise.race([listening.close(), sleep(CLOSE_WAIT_MS)]); // the stop's own reply is flushed before its connection closes; an idle connection must not hold the exit
  return 0;
}
