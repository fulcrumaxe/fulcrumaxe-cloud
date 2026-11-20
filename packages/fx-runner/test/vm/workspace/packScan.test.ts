import { describe, expect, it, vi } from "vitest";
import * as zlib from "node:zlib";

// every inflate the walk makes is recorded with its options: each must be bounded by the size its own header declared
const inflateCalls: Array<{ maxOutputLength: number; inputBytes: number }> = [];
vi.mock("node:zlib", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:zlib")>();
  return { ...real, default: real, inflateSync: (input: Buffer, options: { maxOutputLength: number }) => (inflateCalls.push({ maxOutputLength: options.maxOutputLength, inputBytes: input.length }), real.inflateSync(input, options as never)) };
});

const { scanPack, DEFAULT_PACK_LIMITS } = await import("../../../src/vm/workspace/packScan.js");
const { BundleRefused } = await import("../../../src/vm/workspace/bundleHeader.js");
const { copyDeltaEntry, entryHeader, packOf, plainEntry } = await import("./bombs.js");
const { deflateSync } = zlib;

const code = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof BundleRefused) return error.code;
    throw error;
  }
  return "none";
};
const asBundle = (pack: Buffer): Buffer => Buffer.concat([Buffer.from("# header\n\n"), pack]);

describe("the host's walk of a pack", () => {
  it("bounds every inflate by the size its own header declared, so a header that lies small cannot make the walk inflate more than it said", async () => {
    inflateCalls.length = 0;
    const body = Buffer.from("hello world");
    const bundle = asBundle(packOf({ entries: [plainEntry(3, body), plainEntry(3, Buffer.alloc(0))] }));
    expect(await code(scanPack(bundle, 10))).toBe("none");
    expect(inflateCalls.map((c) => c.maxOutputLength)).toEqual([11, 1]);
    // a header that says 10 over a stream of 300 000 zeros: stopped at the declared size, refused as malformed
    inflateCalls.length = 0;
    const lying = asBundle(packOf({ entries: [Buffer.concat([entryHeader(3, 10), plainEntry(3, Buffer.alloc(300_000)).subarray(entryHeader(3, 300_000).length)])] }));
    expect(await code(scanPack(lying, 10))).toBe("bundle_malformed");
    expect(inflateCalls.map((c) => c.maxOutputLength)).toEqual([10]);
  });

  it("a delta is inflated up to its own instructions' declared size, and its declared result and its own instruction bytes are what count", async () => {
    inflateCalls.length = 0;
    const seed = Buffer.alloc(65536, 7);
    const entry = copyDeltaEntry(Buffer.alloc(20, 1), seed.length, 3 * 65536);
    const bundle = asBundle(packOf({ entries: [entry] }));
    expect(await code(scanPack(bundle, 10, { perObject: 1 << 20, total: 3 * 65536 + 9, objects: 10 }))).toBe("none");
    expect(inflateCalls).toHaveLength(1);
    expect(inflateCalls[0]?.maxOutputLength).toBeLessThan(100);
    expect(await code(scanPack(bundle, 10, { perObject: 1 << 20, total: 3 * 65536 + 8, objects: 10 }))).toBe("bundle_too_large");
  });

  it("the default caps are 100 MiB an object, 1 GiB in all, and 500 000 objects", () => {
    expect(DEFAULT_PACK_LIMITS).toEqual({ perObject: 104_857_600, total: 1_073_741_824, objects: 500_000 });
  });

  it("a pack with the zlib module's own failure (not a stream at all) is malformed, with nothing of zlib's text in the code", async () => {
    const bundle = asBundle(packOf({ entries: [Buffer.concat([entryHeader(3, 5), Buffer.from("not a zlib stream")])] }));
    expect(await code(scanPack(bundle, 10))).toBe("bundle_malformed");
    expect(typeof zlib.inflateSync).toBe("function");
  });
  it("several plain objects, each under the per-object cap, are held to the total: the sum of their header sizes", async () => {
    const entries = [1, 2, 3].map((n) => plainEntry(3, Buffer.concat([Buffer.from([n]), Buffer.alloc(999, n)])));
    const bundle = asBundle(packOf({ entries }));
    expect(await code(scanPack(bundle, 10, { perObject: 2000, total: 3000, objects: 10 }))).toBe("none");
    expect(await code(scanPack(bundle, 10, { perObject: 2000, total: 2999, objects: 10 }))).toBe("bundle_too_large");
  });

  it("a delta's instruction bytes count toward the total as well as its declared result: large instructions with a tiny result are refused", async () => {
    // each delta: 1 MiB of instructions (the two sizes, then zeros), a result of 2 bytes
    const instructions = Buffer.concat([Buffer.from([2, 2]), Buffer.alloc(1024 * 1024 - 2)]);
    const delta = Buffer.concat([entryHeader(7, instructions.length), Buffer.alloc(20, 1), deflateSync(instructions, { level: 9 })]);
    const bundle = asBundle(packOf({ entries: [delta, delta, delta] }));
    const each = instructions.length + 2;
    expect(await code(scanPack(bundle, 10, { perObject: 2 * 1024 * 1024, total: 3 * each, objects: 10 }))).toBe("none");
    expect(await code(scanPack(bundle, 10, { perObject: 2 * 1024 * 1024, total: 3 * each - 1, objects: 10 }))).toBe("bundle_too_large");
    expect(await code(scanPack(bundle, 10, { perObject: 2 * 1024 * 1024, total: 2 * 1024 * 1024, objects: 10 }))).toBe("bundle_too_large");
  });

  it("a header that declares more than the stream holds is malformed (the inflated length must equal the declared size)", async () => {
    const lying = asBundle(packOf({ entries: [Buffer.concat([entryHeader(3, 100), deflateSync(Buffer.from("hi"))])] }));
    expect(await code(scanPack(lying, 10))).toBe("bundle_malformed");
    const honest = asBundle(packOf({ entries: [Buffer.concat([entryHeader(3, 2), deflateSync(Buffer.from("hi"))])] }));
    expect(await code(scanPack(honest, 10))).toBe("none");
  });
});
