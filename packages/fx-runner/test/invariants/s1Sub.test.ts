import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_TOKEN_VAR, cleanEnv } from "../../src/job/cleanEnv.js";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "host-api-key-value");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "host-auth-token-value");
  vi.stubEnv("HOME", "/home/someone");
});
afterEach(() => vi.unstubAllEnvs());

describe("S1-sub: no API key in subscription mode", () => {
  it("the shell's API key never reaches the agent", () => {
    const env = cleanEnv({ mode: "subscription" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(Object.values(env).filter((value) => value.startsWith("host-api") || value.startsWith("host-auth"))).toEqual([]);
  });

  it("a key from local config is ignored: subscription mode has no field for one", () => {
    const smuggled = { mode: "subscription", apiKey: "config-api-key-value" } as never;
    const env = cleanEnv(smuggled);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(Object.values(env)).not.toContain("config-api-key-value");
  });

  it("the subscription token comes through only in subscription mode", () => {
    vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, "host-oauth-value");
    expect(cleanEnv({ mode: "subscription" })[SUBSCRIPTION_TOKEN_VAR]).toBe("host-oauth-value");
    expect(cleanEnv({ mode: "api_key", apiKey: "config-api-key-value" })).not.toHaveProperty(SUBSCRIPTION_TOKEN_VAR);
  });

  // The refusal half needs the sign-in check, which lands with the engine in the next change: when the check is false
  // the job is refused as auth_missing and is never retried in API-key mode.
  it.todo("a missing sign-in refuses the job as auth_missing and never retries in API-key mode (with authPresent)");
});
