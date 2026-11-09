import { describe, expect, it } from "vitest";
import { READER_SLICE_MAX_MS, READER_SLICE_MIN_MS, SLICE_EXIT_RESERVE_MS, ReaderFaultRefusedError, readerConfigFromEnv, sliceEndMs } from "../src/readerConfig.js";

describe("the reader settings", () => {
  it("is off without FX_READER_SLICE_MS, and a bad value is off too", () => {
    for (const v of [undefined, "", "abc", "0", "-5", "1.5"]) expect(readerConfigFromEnv({ FX_READER_SLICE_MS: v })).toBeUndefined();
  });

  it("holds the slice between the floor and the ceiling", () => {
    expect(readerConfigFromEnv({ FX_READER_SLICE_MS: "1" })?.sliceMs).toBe(READER_SLICE_MIN_MS);
    expect(readerConfigFromEnv({ FX_READER_SLICE_MS: "300000" })?.sliceMs).toBe(300_000);
    expect(readerConfigFromEnv({ FX_READER_SLICE_MS: "99999999" })?.sliceMs).toBe(READER_SLICE_MAX_MS);
  });

  it.each([
    ["production", { FX_DEPLOY_KIND: "production" }],
    ["local", { FX_DEPLOY_KIND: "local" }],
    ["unset", {}],
    ["unknown", { FX_DEPLOY_KIND: "stagin" }],
  ])("refuses both fault flags on a %s deployment, whether or not the reader is on", (_n, kind) => {
    for (const flags of [{ FX_READER_CRASH: "2" }, { FX_RECORDER_TAMPER: "1" }, { FX_READER_CRASH: "2", FX_READER_SLICE_MS: "300000" }]) {
      expect(() => readerConfigFromEnv({ ...kind, ...flags })).toThrow(ReaderFaultRefusedError);
    }
    // A flag set to something that would mean "off" is refused too: it is not to be set at all.
    expect(() => readerConfigFromEnv({ ...kind, FX_RECORDER_TAMPER: "0" })).toThrow(ReaderFaultRefusedError);
    expect(() => readerConfigFromEnv({ ...kind, FX_READER_SLICE_MS: "300000" })).not.toThrow();
  });

  it("accepts them on staging only", () => {
    const cfg = readerConfigFromEnv({ FX_DEPLOY_KIND: "staging", FX_READER_SLICE_MS: "300000", FX_READER_CRASH: "3", FX_RECORDER_TAMPER: "1" });
    expect(cfg).toEqual({ sliceMs: 300_000, faults: { crashAtEpoch: 3, tamper: true } });
  });

  it("on a Vercel production deployment the flags need the deployment to say it is staging; one that says production, or nothing, is refused even if its kind reads staging", () => {
    const flags = { FX_DEPLOY_KIND: "staging", FX_READER_CRASH: "2" };
    expect(() => readerConfigFromEnv({ ...flags, VERCEL_ENV: "production" })).toThrow(ReaderFaultRefusedError);
    expect(() => readerConfigFromEnv({ ...flags, VERCEL_ENV: "production", FX_DEPLOY_ENV: "production" })).toThrow(ReaderFaultRefusedError);
    expect(() => readerConfigFromEnv({ ...flags, FX_DEPLOY_ENV: "production" })).toThrow(ReaderFaultRefusedError);
    expect(() => readerConfigFromEnv({ FX_DEPLOY_KIND: "staging", FX_RECORDER_TAMPER: "1", VERCEL_ENV: "production" })).toThrow(ReaderFaultRefusedError);
    expect(readerConfigFromEnv({ ...flags, VERCEL_ENV: "production", FX_DEPLOY_ENV: "staging", FX_READER_SLICE_MS: "300000" })?.faults).toEqual({ crashAtEpoch: 2 });
    expect(readerConfigFromEnv({ ...flags, VERCEL_ENV: "preview", FX_READER_SLICE_MS: "300000" })?.faults).toEqual({ crashAtEpoch: 2 });
  });

  it("ends a slice at the earlier of its length and the invocation's deadline less the exit reserve, never before the floor", () => {
    const cfg = { sliceMs: 300_000, faults: {} };
    expect(sliceEndMs(cfg, 1000, undefined)).toBe(301_000);
    expect(sliceEndMs(cfg, 1000, 1000 + 10_000_000)).toBe(301_000);
    expect(sliceEndMs(cfg, 1000, 1000 + 200_000)).toBe(1000 + 200_000 - SLICE_EXIT_RESERVE_MS);
    expect(sliceEndMs(cfg, 1000, 1001)).toBe(1000 + READER_SLICE_MIN_MS / 2);
  });
});
