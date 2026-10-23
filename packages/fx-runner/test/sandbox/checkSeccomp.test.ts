import { describe, expect, it } from "vitest";
import { FILTER_ARCH_AUDIT, filterAnswer, unixSocketFilter } from "../../src/sandbox/checkSeccomp.js";

/**
 * D#6 R-CHK-2: what the check's seccomp filter decides, read off the program itself with a plain interpreter of its records. The kernel applying it is proved in
 * checkLaunchFeed.bwrap.test.ts and checkSpawn.bwrap.test.ts on real bubblewrap (a Unix socket cannot be connected to, children start with piped stdio, no
 * namespace can be made; each beside the same program without the filter).
 */
const ARCHES = {
  x64: { socket: 41, socketpair: 53, clone: 56, unshare: 272, read: 0, ioUring: [425, 426, 427], other: 0xc00000b7 },
  arm64: { socket: 198, socketpair: 199, clone: 220, unshare: 97, read: 63, ioUring: [425, 426, 427], other: 0xc000003e },
} as const;
const AF = { UNIX: 1, INET: 2, INET6: 10, NETLINK: 16, PACKET: 17, VSOCK: 40 };
const SOCK = { STREAM: 1, DGRAM: 2, RAW: 3, RDM: 4, SEQPACKET: 5, NONBLOCK: 0x800, CLOEXEC: 0x80000 };
const CLONE3 = 435;
// CLONE_NEWTIME, CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET.
const NEW_NAMESPACE = [0x80, 0x20000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000];
// What glibc's fork() and pthread_create() pass to clone, and an unshare that makes no namespace (CLONE_FILES | CLONE_FS).
const FORK_FLAGS = 0x01200011;
const THREAD_FLAGS = 0x003d0f00;
const UNSHARE_PLAIN = 0x00000600;

describe("the check's seccomp filter", () => {
  for (const [name, arch] of Object.entries(ARCHES)) {
    const filter = unixSocketFilter(name)!;
    const call = (nr: number, arg0 = 0, arg1 = 0) => filterAnswer(filter, { arch: FILTER_ARCH_AUDIT[name]!, nr, arg0, arg1 });

    describe(name, () => {
      it("allows ordinary calls and the two internet families (its network namespace is its own), for socket and socketpair alike", () => {
        expect(call(arch.read)).toBe("allow");
        for (const nr of [arch.socket, arch.socketpair]) {
          expect(call(nr, AF.INET)).toBe("allow");
          expect(call(nr, AF.INET6)).toBe("allow");
        }
      });

      it("refuses every other socket family: Unix, netlink, packet, vsock and an unlisted number", () => {
        for (const nr of [arch.socket, arch.socketpair]) for (const family of [AF.UNIX, AF.NETLINK, AF.PACKET, AF.VSOCK, 0, 3, 99]) expect(call(nr, family), `${String(nr)}/${String(family)}`).toBe("eperm");
      });

      it("allows a connected Unix socketpair (stream or seqpacket, any flags): every Node child-process start makes its stdio pipes this way", () => {
        for (const type of [SOCK.STREAM, SOCK.SEQPACKET]) {
          for (const flags of [0, SOCK.CLOEXEC, SOCK.NONBLOCK, SOCK.CLOEXEC | SOCK.NONBLOCK]) expect(call(arch.socketpair, AF.UNIX, type | flags), `${String(type)}/${String(flags)}`).toBe("allow");
        }
      });

      it("still refuses a Unix socket that can be pointed at another endpoint: socket(AF_UNIX) of any type, and a socketpair of any other type", () => {
        for (const type of [SOCK.STREAM, SOCK.DGRAM, SOCK.SEQPACKET, SOCK.STREAM | SOCK.CLOEXEC]) expect(call(arch.socket, AF.UNIX, type), String(type)).toBe("eperm");
        for (const type of [0, SOCK.DGRAM, SOCK.RAW, SOCK.RDM, 6, 10, SOCK.DGRAM | SOCK.CLOEXEC, SOCK.DGRAM | SOCK.NONBLOCK]) expect(call(arch.socketpair, AF.UNIX, type), String(type)).toBe("eperm");
        for (const family of [AF.NETLINK, AF.PACKET, AF.VSOCK]) expect(call(arch.socketpair, family, SOCK.STREAM), String(family)).toBe("eperm");
      });

      it("refuses clone and unshare asking for any new namespace, alone or among other flags, and allows them without one", () => {
        for (const flag of NEW_NAMESPACE) {
          expect(call(arch.unshare, flag), `unshare ${flag.toString(16)}`).toBe("eperm");
          expect(call(arch.unshare, flag | UNSHARE_PLAIN), `unshare ${flag.toString(16)}+`).toBe("eperm");
          expect(call(arch.clone, flag | FORK_FLAGS), `clone ${flag.toString(16)}`).toBe("eperm");
        }
        expect(call(arch.clone, FORK_FLAGS)).toBe("allow");
        expect(call(arch.clone, THREAD_FLAGS)).toBe("allow");
        expect(call(arch.unshare, UNSHARE_PLAIN)).toBe("allow");
      });

      it("answers clone3 with ENOSYS whatever its argument, so libc falls back to clone, whose flags the filter reads", () => {
        for (const arg0 of [0, 0x7fff0000, 0xffffffff]) expect(call(CLONE3, arg0)).toBe("enosys");
      });

      it("refuses io_uring_setup, io_uring_enter and io_uring_register, and allows the numbers next to them", () => {
        for (const nr of arch.ioUring) expect(call(nr), String(nr)).toBe("eperm");
        expect(call(424)).toBe("allow");
        expect(call(428)).toBe("allow");
      });

      it("refuses another architecture's calls whatever they are", () => {
        expect(filterAnswer(filter, { arch: arch.other, nr: arch.read, arg0: 0 })).toBe("eperm");
        expect(filterAnswer(filter, { arch: 0x40000003, nr: 3, arg0: 0 })).toBe("eperm");
      });
    });
  }

  it("on x86-64 every number with the x32 bit set is refused, the socket calls and io_uring numbers among them", () => {
    const filter = unixSocketFilter("x64")!;
    const call = (nr: number, arg0 = 0) => filterAnswer(filter, { arch: FILTER_ARCH_AUDIT["x64"]!, nr, arg0 });
    for (const nr of [0x40000000, 0x40000000 | 41, 0x40000000 | 53, 0x40000000 | 56, 0x40000000 | 272, 0x40000000 | 425, 0x40000000 | 435, 0x40000000 | 1, 0x7fffffff]) expect(call(nr, AF.INET), String(nr)).toBe("eperm");
  });

  it("an architecture it does not know gets no filter, so the check is refused", () => {
    expect(unixSocketFilter("ia32")).toBeUndefined();
    expect(unixSocketFilter("riscv64")).toBeUndefined();
  });
});
