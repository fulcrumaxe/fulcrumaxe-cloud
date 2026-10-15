import { describe, expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION, HANDOFF_MIN_PROTOCOL_VERSION, HelloMessage, MIN_SUPPORTED_PROTOCOL_VERSION } from "../src/messages.js";
import { HeartbeatReply } from "../src/replies.js";

describe("protocol versions", () => {
  it("keeps the floor apart from the current version, so a bump gates a capability and cuts nobody off", () => {
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBe(1);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThan(MIN_SUPPORTED_PROTOCOL_VERSION);
  });

  it("makes the current version the one a runner needs to act on a handoff", () => {
    expect(HANDOFF_MIN_PROTOCOL_VERSION).toBe(2);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(HANDOFF_MIN_PROTOCOL_VERSION);
  });

  it("has a hello of the floor version that still parses (an older runner stays valid) and so does one of the current version", () => {
    const hello = (protocol_version: number) => HelloMessage.safeParse({ protocol_version, binary_version: "0.1.0", model_auth_present: true, isolation: "host_sandbox" }).success;
    expect(hello(MIN_SUPPORTED_PROTOCOL_VERSION)).toBe(true);
    expect(hello(CURRENT_PROTOCOL_VERSION)).toBe(true);
  });

  it("keeps the heartbeat reply strict: a reply with a handoff is not readable by a parse that predates the field", () => {
    const before = HeartbeatReply.omit({ handoff: true });
    const reply = { continue: true, lease_expires_at: "2026-10-11T12:00:00.000Z", handoff: { requested: true, deadline: "2026-10-11T12:05:00.000Z" } };
    expect(HeartbeatReply.safeParse(reply).success).toBe(true);
    expect(before.safeParse(reply).success).toBe(false);
  });
});
