import { describe, expect, it } from "vitest";
import { ClaimMessage, HOST_LOAD_MAX_MB, HOST_LOAD_MAX_SETUPS, HelloMessage, HostLoad, MACHINE_ONBOARDING_MIN_PROTOCOL, MIN_SUPPORTED_PROTOCOL_VERSION } from "../src/messages.js";

/** D#845 ON-1: the machine load block on a claim, gated at protocol 22. */
const load = (over: Record<string, unknown> = {}) => ({ mem_avail_mb: 9100, disk_free_mb: 250000, setups_running: 1, ...over });
const good = (value: unknown): boolean => ClaimMessage.safeParse({ host_load: value }).success;

describe("host load on a claim", () => {
  it("is optional, so a claim without it, and every older hello, still validates", () => {
    expect(ClaimMessage.safeParse({}).success).toBe(true);
    expect(ClaimMessage.safeParse({ sandboxes: [] }).success).toBe(true);
    for (let version = MIN_SUPPORTED_PROTOCOL_VERSION; version <= MACHINE_ONBOARDING_MIN_PROTOCOL; version++) {
      expect(HelloMessage.safeParse({ protocol_version: version, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox" }).success, String(version)).toBe(true);
    }
  });
  it("takes three whole numbers within their bounds", () => {
    expect(good(load())).toBe(true);
    expect(good(load({ mem_avail_mb: 0, disk_free_mb: 0, setups_running: 0 }))).toBe(true);
    expect(good(load({ mem_avail_mb: HOST_LOAD_MAX_MB, disk_free_mb: HOST_LOAD_MAX_MB, setups_running: HOST_LOAD_MAX_SETUPS }))).toBe(true);
    expect(HostLoad.safeParse(load()).success).toBe(true);
  });
  it("refuses a missing field, an extra key, a negative, a fraction, a string, a number over its cap and an unsafe integer", () => {
    for (const key of ["mem_avail_mb", "disk_free_mb", "setups_running"]) {
      const rest: Record<string, unknown> = load();
      delete rest[key];
      expect(good(rest), `no ${key}`).toBe(false);
      for (const bad of [-1, 1.5, "5", null, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) expect(good(load({ [key]: bad })), `${key} ${String(bad)}`).toBe(false);
    }
    expect(good(load({ mem_avail_mb: HOST_LOAD_MAX_MB + 1 }))).toBe(false);
    expect(good(load({ disk_free_mb: HOST_LOAD_MAX_MB + 1 }))).toBe(false);
    expect(good(load({ setups_running: HOST_LOAD_MAX_SETUPS + 1 }))).toBe(false);
    expect(good(load({ hostname: "box" }))).toBe(false);
    expect(good({})).toBe(false);
    expect(good(null)).toBe(false);
    expect(ClaimMessage.safeParse({ host_load: load(), mem_avail_mb: 1 }).success).toBe(false);
  });
});
