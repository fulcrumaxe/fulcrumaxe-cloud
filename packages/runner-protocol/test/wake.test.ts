import { describe, expect, it } from "vitest";
import {
  ClaimIdleReply,
  ClaimReply,
  HelloMessage,
  HelloReply,
  RUNNER_CAPABILITIES,
  RUNNER_CAPABILITY_FOR_ROLE,
  WAKE_CAPABILITY,
  WAKE_TRANSPORTS,
  WakeGrant,
  WakeTokenPayload,
  effectiveWakeTransport,
} from "../src/index.js";
import { g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

const B43 = "A".repeat(43);
const TOKEN = `eyJ2IjoxfQ.${"b".repeat(43)}`;
const GRANT = { token: TOKEN, poll_s: 20, transport: "poll" };
const PAYLOAD = { v: 1, rid: "7d1f6a3e-2b1c-4e8f-9a0b-1c2d3e4f5a6b", acct: "0b6f2c1d-3e4a-4b5c-8d9e-0f1a2b3c4d5e", jkt: B43, jwk_x: B43, exp: 1_800_000_000 };
const HELLO = { protocol_version: 1, binary_version: "0.4.2", model_auth_present: false, isolation: "host_sandbox" };

/** D#6 RUNNER-WAKE R3a: the wake credential's shapes. */
describe("wake capability", () => {
  it("is a runner capability a hello may list, and gates no role", () => {
    expect(RUNNER_CAPABILITIES).toContain(WAKE_CAPABILITY);
    expect(Object.values(RUNNER_CAPABILITY_FOR_ROLE)).not.toContain(WAKE_CAPABILITY);
    expect(HelloMessage.safeParse({ ...HELLO, capabilities: ["wake_v1"] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...HELLO, capabilities: ["proposal_verifier", "wake_v1"] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...HELLO, capabilities: ["wake_v1", "wake_v1"] }).success).toBe(false);
    expect(HelloMessage.safeParse({ ...HELLO, capabilities: ["wake_v2"] }).success).toBe(false);
  });
});

describe("wake token payload", () => {
  it("is strict and versioned, and names the runner, its account, its key and an expiry, and nothing about the transport", () => {
    expect(WakeTokenPayload.safeParse(PAYLOAD).success).toBe(true);
    expect(Object.keys(WakeTokenPayload.shape).sort()).toEqual(["acct", "exp", "jkt", "jwk_x", "rid", "v"]);
    expect(nonStrictObjects(WakeTokenPayload)).toEqual([]);
    for (const bad of [{ ...PAYLOAD, v: 2 }, { ...PAYLOAD, rid: "x" }, { ...PAYLOAD, acct: undefined }, { ...PAYLOAD, jkt: "short" }, { ...PAYLOAD, exp: 1.5 }, { ...PAYLOAD, poll_s: 20 }, { ...PAYLOAD, transport: "poll" }]) {
      expect(WakeTokenPayload.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("wake grant", () => {
  it("is strict: token, poll_s and transport only, poll_s within bounds, the token in its two-part form", () => {
    expect(WakeGrant.safeParse(GRANT).success).toBe(true);
    expect(nonStrictObjects(WakeGrant)).toEqual([]);
    expect(g1Violations(WakeGrant)).toEqual([]);
    for (const bad of [
      { ...GRANT, extra: 1 },
      { ...GRANT, poll_s: 4 },
      { ...GRANT, poll_s: 3601 },
      { ...GRANT, poll_s: 20.5 },
      { ...GRANT, token: "no-dot" },
      { ...GRANT, token: `${TOKEN}.x` },
      { ...GRANT, token: `a.${"b".repeat(42)}` },
      { ...GRANT, token: `${"a".repeat(1000)}.${"b".repeat(43)}` },
      { token: TOKEN, poll_s: 20 },
      { ...GRANT, transport: "" },
      { ...GRANT, transport: "Poll" },
      { ...GRANT, transport: "x".repeat(33) },
    ]) {
      expect(WakeGrant.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it("only poll is sent today, and a transport a runner does not know reads as poll (a newer cloud meets an older runner safely)", () => {
    expect(WAKE_TRANSPORTS).toEqual(["poll"]);
    expect(WakeGrant.safeParse({ ...GRANT, transport: "sse" }).success).toBe(true);
    expect(effectiveWakeTransport("poll")).toBe("poll");
    expect(effectiveWakeTransport("sse")).toBe("poll");
    expect(effectiveWakeTransport("longpoll")).toBe("poll");
  });
});

describe("the grant on hello and claim replies", () => {
  it("is optional on every 200 hello and claim reply, so a reply without it parses as before", () => {
    expect(HelloReply.safeParse({ protocol_version: 8 }).success).toBe(true);
    expect(HelloReply.safeParse({ protocol_version: 8, wake: GRANT }).success).toBe(true);
    expect(ClaimIdleReply.safeParse({ retry_after: 60 }).success).toBe(true);
    expect(ClaimReply.safeParse({ retry_after: 60, wake: GRANT }).success).toBe(true);
  });

  it("refuses a malformed grant and any other unknown key", () => {
    expect(HelloReply.safeParse({ protocol_version: 8, wake: { ...GRANT, poll_s: 0 } }).success).toBe(false);
    expect(HelloReply.safeParse({ protocol_version: 8, other: 1 }).success).toBe(false);
    expect(ClaimReply.safeParse({ retry_after: 60, wake: { ...GRANT, rid: PAYLOAD.rid } }).success).toBe(false);
  });
});
