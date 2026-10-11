import { describe, expect, it } from "vitest";
import { HelloMessage } from "@fulcrumaxe/runner-protocol";
import { defaultRunnerName, hostFactsOf, memBucketOf, readHostFacts } from "../src/hostFacts.js";

const GB = 1024 ** 3;
const hello = (facts: unknown) => HelloMessage.safeParse({ protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "host_sandbox", facts }).success;

describe("memBucketOf (D#605 FL-2)", () => {
  it("reports the largest bucket the machine reaches once its memory is rounded up to whole gigabytes", () => {
    expect(memBucketOf(15.6 * GB)).toBe(16); // a 16 GB machine reports a little under 16 GiB
    expect(memBucketOf(16 * GB)).toBe(16);
    expect(memBucketOf(16.01 * GB)).toBe(16);
    expect(memBucketOf(31.4 * GB)).toBe(32); // a 32 GB machine reports a little under 32 GiB
    expect(memBucketOf(31 * GB)).toBe(16);
    expect(memBucketOf(33 * GB)).toBe(32);
    expect(memBucketOf(64 * GB)).toBe(64);
    expect(memBucketOf(1000 * GB)).toBe(128);
  });
  it("never goes below the smallest bucket, and survives nonsense", () => {
    for (const bytes of [0, 1, 2 * GB, 3.2 * GB, -5, Number.NaN, Number.POSITIVE_INFINITY * 0]) expect(memBucketOf(bytes), String(bytes)).toBe(4);
  });
});

describe("hostFactsOf", () => {
  const base = { platform: "linux", arch: "x64", totalMemBytes: 16 * GB, cpus: 8 } as const;
  it("maps the platforms and architectures the runner supports, and says os_sandbox for this build", () => {
    expect(hostFactsOf(base)).toEqual({ os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" });
    expect(hostFactsOf({ ...base, platform: "darwin", arch: "arm64" })).toMatchObject({ os: "macos", arch: "arm64" });
  });
  it("sends no facts at all for a machine the protocol does not name, rather than a wrong one", () => {
    expect(hostFactsOf({ ...base, platform: "win32" })).toBeUndefined();
    expect(hostFactsOf({ ...base, platform: "freebsd" })).toBeUndefined();
    expect(hostFactsOf({ ...base, arch: "ia32" })).toBeUndefined();
    expect(hostFactsOf({ ...base, arch: "riscv64" })).toBeUndefined();
  });
  it("clamps the cpu count into 1 to 256", () => {
    expect(hostFactsOf({ ...base, cpus: 0 })?.cpus).toBe(1);
    expect(hostFactsOf({ ...base, cpus: Number.NaN })?.cpus).toBe(1);
    expect(hostFactsOf({ ...base, cpus: 4096 })?.cpus).toBe(256);
    expect(hostFactsOf({ ...base, cpus: 7.9 })?.cpus).toBe(7);
  });
  it("whatever it returns is accepted by the cloud's strict hello schema, and the real machine's facts are too", () => {
    for (const cpus of [0, 1, 8, 4096]) for (const totalMemBytes of [0, 3 * GB, 16 * GB, 500 * GB]) expect(hello(hostFactsOf({ ...base, cpus, totalMemBytes })), `${cpus} ${totalMemBytes}`).toBe(true);
    const real = readHostFacts();
    if (real !== undefined) expect(hello(real)).toBe(true);
  });
});

describe("defaultRunnerName", () => {
  it("uses a usual host name as it is", () => {
    expect(defaultRunnerName("studio-mac.local")).toBe("studio-mac.local");
    expect(defaultRunnerName("Büro Desktop")).toBe("Büro Desktop");
  });
  it("drops control, invisible and bidirectional characters instead of sending a name the cloud would refuse", () => {
    expect(defaultRunnerName("web\u0007-01‮")).toBe("web-01");
    expect(defaultRunnerName("a​b")).toBe("ab");
  });
  it("cuts at 64 characters (not UTF-16 units) and trims the ends", () => {
    expect(defaultRunnerName("h".repeat(80))).toBe("h".repeat(64));
    expect([...(defaultRunnerName("\u{1f600}".repeat(80)) ?? "")]).toHaveLength(64);
    expect(defaultRunnerName("  box  ")).toBe("box");
    expect(defaultRunnerName(`${"x".repeat(63)} y`)).toBe("x".repeat(63));
  });
  it("gives nothing when nothing printable is left, so the register request carries no name", () => {
    for (const hostname of ["", "   ", "​\u0007", "⠀", "\n"]) expect(defaultRunnerName(hostname), JSON.stringify(hostname)).toBeUndefined();
  });
});
