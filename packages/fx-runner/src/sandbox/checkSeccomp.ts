/**
 * D#6 R-CHK-2: the seccomp filter the job's check runs under. The check has no network (its network namespace is its own), so the only sockets it has any use for are
 * loopback ones: this is an allow-list of socket families, and everything else is refused. In particular no Unix-domain socket that can reach another endpoint can be
 * made (C39 B1), so the user's session bus, a container runtime's socket and a display server are out of reach even where a path to them exists.
 *
 * It is a classic BPF program in the form bubblewrap's `--seccomp FD` reads (a sequence of 8-byte `sock_filter` records), built for the architecture this process runs
 * on and nothing else:
 *  - a call made through another architecture's numbers (a 32-bit program) answers EPERM, and on x86-64 so does every number with the x32 bit (0x40000000) set, which would
 *    otherwise reach the same kernel calls under numbers this filter does not list;
 *  - `io_uring_setup`, `io_uring_enter` and `io_uring_register` (425 to 427 on both architectures) answer EPERM: an io_uring ring can issue socket and connect operations
 *    without going through the `socket` call this filter reads;
 *  - `socket` is allowed only for `AF_INET` and `AF_INET6`; any other family (Unix, netlink, packet, vsock, and the rest) answers EPERM;
 *  - `socketpair` is allowed for those two and for `AF_UNIX` of type `SOCK_STREAM` or `SOCK_SEQPACKET` (any flags), and refused otherwise. Every child-process start in
 *    Node (libuv) makes its stdio pipes this way, so refusing it broke every spawn in the check. Such a pair is born connected to itself and has no name: `connect` on it
 *    never connects (the kernel may answer ENOENT or EACCES from the path lookup before it reaches the already-connected state) and `sendmsg` ignores or refuses a
 *    destination address, so it cannot reach any socket outside the pair. A `SOCK_DGRAM` pair can be re-pointed at a
 *    named socket (`connect` or `sendto` with an address), so that type stays refused;
 *  - `unshare` and `clone` answer EPERM when their flags ask for any new namespace (mount, cgroup, UTS, IPC, user, PID, network, time): the check stays in the namespaces
 *    bubblewrap made for it, so it cannot get a fresh user namespace's capabilities to work with;
 *  - `clone3` answers ENOSYS: its flags are in memory the filter cannot read, and ENOSYS (unlike EPERM) is the answer glibc and libuv fall back to `clone` on, which the
 *    rule above reads;
 *  - every other call is allowed.
 * Linux x86-64 and arm64 only; any other machine gets `undefined` and the check is refused.
 */
import os from "node:os";

const LD_W_ABS = 0x20;
const AND_K = 0x54;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;
const ALLOW = 0x7fff0000;
const EPERM = 1;
const ENOSYS = 38;
const DENY = 0x00050000 | EPERM;
const NO_SUCH_CALL = 0x00050000 | ENOSYS;
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const SOCK_TYPE_MASK = 0xf;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
// CLONE_NEWTIME | CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET. In `clone` the low byte is the exit signal
// (at most 64), so 0x80 is never set by a valid call there and refusing it costs nothing.
const NEW_NAMESPACE_FLAGS = 0x00000080 | 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;
const X32_BIT = 0x40000000;
const IO_URING_FIRST = 425;
const IO_URING_LAST = 427;
const CLONE3 = 435;
const ARCHES: Readonly<Record<string, { audit: number; socket: number; socketpair: number; clone: number; unshare: number; x32: boolean }>> = Object.freeze({
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53, clone: 56, unshare: 272, x32: true },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199, clone: 220, unshare: 97, x32: false },
});

type Step = { label?: string; code: number; k: number; jt?: string; jf?: string };

/** Assembles steps whose jumps name labels; a jump is always forward, as the kernel requires. */
function assemble(steps: readonly Step[]): Buffer {
  const at = new Map<string, number>();
  steps.forEach((step, index) => {
    if (step.label !== undefined) at.set(step.label, index);
  });
  const rel = (from: number, label: string | undefined): number => {
    if (label === undefined) return 0;
    const target = at.get(label);
    if (target === undefined || target <= from || target - from - 1 > 255) throw new Error("seccomp filter: bad jump");
    return target - from - 1;
  };
  return Buffer.concat(
    steps.map((step, index) => {
      const out = Buffer.alloc(8);
      out.writeUInt16LE(step.code, 0);
      out.writeUInt8(rel(index, step.jt), 2);
      out.writeUInt8(rel(index, step.jf), 3);
      out.writeUInt32LE(step.k >>> 0, 4);
      return out;
    }),
  );
}

/** The filter for an architecture name as `os.arch()` gives it (default: this machine's), or undefined for one this file does not know. */
export function unixSocketFilter(arch: string = os.arch()): Buffer | undefined {
  const known = ARCHES[arch];
  if (known === undefined) return undefined;
  return assemble([
    { code: LD_W_ABS, k: 4 }, // the architecture
    { code: JEQ_K, k: known.audit, jf: "deny" },
    { code: LD_W_ABS, k: 0 }, // the system call number
    ...(known.x32 ? [{ code: JGE_K, k: X32_BIT, jt: "deny" } as Step] : []),
    { code: JEQ_K, k: CLONE3, jt: "nosys" },
    { code: JEQ_K, k: known.clone, jt: "namespaces" },
    { code: JEQ_K, k: known.unshare, jt: "namespaces" },
    { code: JGE_K, k: IO_URING_FIRST, jf: "sockets" }, // below the io_uring numbers
    { code: JGE_K, k: IO_URING_LAST + 1, jt: "sockets", jf: "deny" }, // 425 to 427
    { label: "sockets", code: JEQ_K, k: known.socket, jt: "family" },
    { code: JEQ_K, k: known.socketpair, jt: "pair", jf: "allow" },
    { label: "family", code: LD_W_ABS, k: 16 }, // the first argument (the domain), low half
    { code: JEQ_K, k: AF_INET, jt: "allow" },
    { code: JEQ_K, k: AF_INET6, jt: "allow", jf: "deny" },
    { label: "pair", code: LD_W_ABS, k: 16 }, // socketpair's domain
    { code: JEQ_K, k: AF_INET, jt: "allow" },
    { code: JEQ_K, k: AF_INET6, jt: "allow" },
    { code: JEQ_K, k: AF_UNIX, jf: "deny" },
    { code: LD_W_ABS, k: 24 }, // the second argument (the type), low half
    { code: AND_K, k: SOCK_TYPE_MASK }, // without SOCK_NONBLOCK and SOCK_CLOEXEC
    { code: JEQ_K, k: SOCK_STREAM, jt: "allow" },
    { code: JEQ_K, k: SOCK_SEQPACKET, jt: "allow", jf: "deny" },
    { label: "namespaces", code: LD_W_ABS, k: 16 }, // the flags (the first argument of both calls), low half
    { code: JSET_K, k: NEW_NAMESPACE_FLAGS, jt: "deny", jf: "allow" },
    { label: "allow", code: RET_K, k: ALLOW },
    { label: "deny", code: RET_K, k: DENY },
    { label: "nosys", code: RET_K, k: NO_SUCH_CALL },
  ]);
}

/** The program's answer for one call, by a plain interpreter of the records (the tests' way of reading what a filter decides). */
export function filterAnswer(filter: Buffer, call: { arch: number; nr: number; arg0: number; arg1?: number }): "allow" | "eperm" | "enosys" | "other" {
  let acc = 0;
  for (let pc = 0; pc < filter.length / 8; ) {
    const code = filter.readUInt16LE(pc * 8);
    const jt = filter.readUInt8(pc * 8 + 2);
    const jf = filter.readUInt8(pc * 8 + 3);
    const k = filter.readUInt32LE(pc * 8 + 4);
    pc += 1;
    if (code === LD_W_ABS) acc = (k === 4 ? call.arch : k === 0 ? call.nr : k === 16 ? call.arg0 : k === 24 ? call.arg1 ?? 0 : 0) >>> 0;
    else if (code === AND_K) acc = (acc & k) >>> 0;
    else if (code === JEQ_K) pc += acc === k ? jt : jf;
    else if (code === JGE_K) pc += acc >= k ? jt : jf;
    else if (code === JSET_K) pc += (acc & k) !== 0 ? jt : jf;
    else if (code === RET_K) return k === ALLOW ? "allow" : k === DENY ? "eperm" : k === NO_SUCH_CALL ? "enosys" : "other";
    else return "other";
  }
  return "other";
}

export const FILTER_ARCH_AUDIT: Readonly<Record<string, number>> = Object.freeze({ x64: 0xc000003e, arm64: 0xc00000b7 });
