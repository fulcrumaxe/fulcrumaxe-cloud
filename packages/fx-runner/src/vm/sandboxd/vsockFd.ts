/**
 * The runner's side of the vsock directory contract (D#587 decision doc, Correction 8): the directory and `v.sock` are looked at through
 * O_PATH|O_NOFOLLOW file descriptors, and the connect goes through the process's own descriptor table, never through a path a sandbox could re-point between the
 * check and the connect. A symlink is refused, and so is any `v.sock` that is not a socket owned by the runner's own euid (the helper hands it
 * over to the runner after the VM starts). Linux only: elsewhere nothing is inspected and nothing connects.
 */
import fs from "node:fs";
import net from "node:net";
import type { DirFacts } from "./sandboxd.js";

/** `O_PATH` as Linux defines it (asm-generic/fcntl.h); Node hands numeric flags to open(2) unchanged and has no named constant for it. */
export const O_PATH = 0o10000000;
export const VSOCK_SOCKET_NAME = "v.sock";

export interface FdStat {
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  gid: number;
  mode: number;
}

/** The system calls the checks make, so a test can hand in another owner or watch the connect path. */
export interface FdOps {
  euid: number;
  open(path: string, flags: number): number;
  fstat(fd: number): FdStat;
  close(fd: number): void;
  /** Removes the entry `path` names (an unlink: a final symlink is removed, never followed). */
  unlink(path: string): void;
  /** Starts the connect to `path` (what `net.createConnection` does); the caller waits for it. */
  dial(path: string): net.Socket;
}

export class VsockRefused extends Error {
  constructor() {
    super("fx-sandboxd: the vsock socket was refused");
    this.name = "VsockRefused";
  }
}

/** What the caller knows of the host: `process.geteuid()` (undefined where there is none) and `process.platform`. */
export interface HostFacts {
  euid: number | undefined;
  platform: string;
}

export function realFdOps(host: HostFacts): FdOps {
  const euid = host.euid;
  if (host.platform !== "linux" || typeof euid !== "number") throw new VsockRefused(); // no O_PATH here: never fall back to plain paths
  return { euid, open: (p, flags) => fs.openSync(p, flags), fstat: (fd) => fs.fstatSync(fd), close: (fd) => fs.closeSync(fd), unlink: (p) => fs.unlinkSync(p), dial: (p) => net.createConnection(p) };
}

const NO_FOLLOW = fs.constants.O_NOFOLLOW;

/** What fstat of an O_PATH|O_NOFOLLOW fd of `dir` shows (a symlink is reported as one); undefined when it cannot be opened or read. */
export function fdInspectDir(dir: string, ops: FdOps): DirFacts | undefined {
  let fd: number | undefined;
  try {
    const o = ops;
    fd = o.open(dir, O_PATH | NO_FOLLOW);
    const st = o.fstat(fd);
    return { isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), uid: st.uid, gid: st.gid, mode: st.mode };
  } catch {
    // fx-swallow-ok: a directory that cannot be inspected is refused by checkVsockDir with a fixed error
    return undefined;
  } finally {
    if (fd !== undefined) closeQuietly(ops, fd);
  }
}

function closeQuietly(ops: FdOps, fd: number): void {
  try {
    ops.close(fd);
  } catch {
    // fx-swallow-ok: the fd was only for a check; a failed close changes nothing the caller can act on
  }
}

/**
 * Opens `dir` and then `v.sock` inside it by O_PATH|O_NOFOLLOW fds, requires a socket owned by the runner, and connects through
 * the checked socket's own descriptor. The fds are closed once the connect has finished. Any refusal rejects with `VsockRefused`.
 */
export async function dialVsockDir(dir: string, ops: FdOps): Promise<net.Socket> {
  const o = ops;
  const fds: number[] = [];
  try {
    const dirFd = o.open(dir, O_PATH | NO_FOLLOW | fs.constants.O_DIRECTORY);
    fds.push(dirFd);
    const d = o.fstat(dirFd);
    if (!d.isDirectory() || d.uid !== o.euid) throw new VsockRefused();
    const sockFd = o.open(`/proc/self/fd/${dirFd}/${VSOCK_SOCKET_NAME}`, O_PATH | NO_FOLLOW);
    fds.push(sockFd);
    const s = o.fstat(sockFd);
    if (!s.isSocket() || s.isSymbolicLink() || s.uid !== o.euid) throw new VsockRefused();
    const socket = o.dial(`/proc/self/fd/${sockFd}`);
    return await new Promise<net.Socket>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
    });
  } catch {
    // fx-swallow-ok: the caller maps every refusal and failure to one fixed error; the system message could name a path
    throw new VsockRefused();
  } finally {
    for (const fd of fds) closeQuietly(ops, fd);
  }
}

/** Name prefix of the runner-side listeners (`v.sock_<port>`) the runner creates itself before the VM starts. */
const LISTENER_PREFIX = `${VSOCK_SOCKET_NAME}_`;

/**
 * True when `dir` holds any `v.sock_*` entry that is not owned by the runner's euid (or cannot be examined): a planted listener name. Each
 * entry is looked at through an O_PATH|O_NOFOLLOW fd inside the directory fd, so a symlink counts as the foreign thing it is. An unreadable
 * directory answers true: the daemon refuses to start a sandbox it cannot vouch for.
 */
export function hasForeignListener(dir: string, ops: FdOps): boolean {
  const fds: number[] = [];
  try {
    const o = ops;
    const dirFd = o.open(dir, O_PATH | NO_FOLLOW | fs.constants.O_DIRECTORY);
    fds.push(dirFd);
    for (const name of fs.readdirSync(`/proc/self/fd/${dirFd}`)) {
      if (!name.startsWith(LISTENER_PREFIX)) continue;
      const fd = o.open(`/proc/self/fd/${dirFd}/${name}`, O_PATH | NO_FOLLOW);
      fds.push(fd);
      const st = o.fstat(fd);
      if (st.isSymbolicLink() || st.uid !== o.euid) return true; // the runner makes sockets, never links: a link here is planted, whoever owns it
    }
    return false;
  } catch {
    // fx-swallow-ok: what cannot be examined cannot be vouched for, so the answer is "foreign"
    return true;
  } finally {
    for (const fd of fds) closeQuietly(ops, fd);
  }
}

/**
 * Before `resume` (D#587 B-3b): the stopped VM's host-side `v.sock` still belongs to the runner, the helper cannot remove it (the directory is the
 * runner's) and Firecracker cannot bind over it, so the runner removes it. The directory and the entry are opened O_PATH|O_NOFOLLOW and the unlink
 * goes through the directory's fd. The entry goes only when it is a socket owned by the runner's own euid; nothing there is fine; a link, a plain
 * file or another owner's socket is refused with `VsockRefused` and left in place, so a planted entry is neither deleted on the runner's authority
 * nor resumed over.
 */
export function removeOwnVsockSocket(dir: string, ops: FdOps): void {
  const fds: number[] = [];
  try {
    const dirFd = ops.open(dir, O_PATH | NO_FOLLOW | fs.constants.O_DIRECTORY);
    fds.push(dirFd);
    const d = ops.fstat(dirFd);
    if (!d.isDirectory() || d.uid !== ops.euid) throw new VsockRefused();
    const entry = `/proc/self/fd/${dirFd}/${VSOCK_SOCKET_NAME}`;
    let sockFd: number;
    try {
      sockFd = ops.open(entry, O_PATH | NO_FOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing left behind
      throw err;
    }
    fds.push(sockFd);
    const s = ops.fstat(sockFd);
    if (!s.isSocket() || s.isSymbolicLink() || s.uid !== ops.euid) throw new VsockRefused();
    ops.unlink(entry);
  } catch {
    // fx-swallow-ok: one fixed refusal for every failure; the system's message could name a path
    throw new VsockRefused();
  } finally {
    for (const fd of fds) closeQuietly(ops, fd);
  }
}
