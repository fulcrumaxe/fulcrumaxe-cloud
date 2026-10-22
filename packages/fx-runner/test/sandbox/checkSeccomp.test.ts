import { describe, expect, it } from "vitest";
import { FILTER_ARCH_AUDIT, filterAnswer, unixSocketFilter } from "../../src/sandbox/checkSeccomp.js";

/**
 * D#6 R-CHK-2: what the check's seccomp filter decides, read off the program itself with a plain interpreter of its records. The kernel applying it is proved in
 * hostSandboxCheck.bwrap.test.ts on real bubblewrap (a Unix socket cannot be connected to; the same program connects without the filter).
 */
const ARCHES = {
  x64: { socket: 41, socketpair: 53, read: 0, ioUring: [425, 426, 427], other: 0xc00000b7 },
  arm64: { socket: 198, socketpair: 199, read: 63, ioUring: [425, 426, 427], other: 0xc000003e },
} as const;
const AF = { UNIX: 1, INET: 2, INET6: 10, NETLINK: 16, PACKET: 17, VSOCK: 40 };

describe("the check's seccomp filter", () => {
  for (const [name, arch] of Object.entries(ARCHES)) {
    const filter = unixSocketFilter(name)!;
    const call = (nr: number, arg0 = 0) => filterAnswer(filter, { arch: FILTER_ARCH_AUDIT[name]!, nr, arg0 });

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
    for (const nr of [0x40000000, 0x40000000 | 41, 0x40000000 | 425, 0x40000000 | 1, 0x7fffffff]) expect(call(nr, AF.INET), String(nr)).toBe("eperm");
  });

  it("an architecture it does not know gets no filter, so the check is refused", () => {
    expect(unixSocketFilter("ia32")).toBeUndefined();
    expect(unixSocketFilter("riscv64")).toBeUndefined();
  });
});
