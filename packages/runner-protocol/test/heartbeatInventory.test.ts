import { describe, expect, it } from "vitest";
import { HEARTBEAT_INVENTORY_CAPABILITY, HEARTBEAT_INVENTORY_HELLO_CAPABILITY, HELLO_REPLY_CAPABILITIES, HeartbeatMessage, HeartbeatReply, HelloMessage, RUNNER_CAPABILITIES, SANDBOX_INVENTORY_MIN_PROTOCOL } from "../src/index.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const row = { name: "job-vm", state: "running", created_at: "2026-11-21T10:00:00Z", last_used_at: null, disk_bytes: 1, snapshot_count: 0, snapshot_age_s: null };
const hello = { binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox" } as const;

/** D#587 FU-179: the heartbeat's optional inventory and the hello handshake that gates it. */
describe("heartbeat inventory in the protocol", () => {
  it("names the hello capability and the reply's closed one", () => {
    expect(HEARTBEAT_INVENTORY_HELLO_CAPABILITY).toBe("heartbeat_inventory_v1");
    expect(HEARTBEAT_INVENTORY_CAPABILITY).toBe("heartbeat_inventory");
    expect(RUNNER_CAPABILITIES).toContain(HEARTBEAT_INVENTORY_HELLO_CAPABILITY);
    expect(HELLO_REPLY_CAPABILITIES).toContain(HEARTBEAT_INVENTORY_CAPABILITY);
  });

  it("a plain heartbeat still parses, and sandboxes is the same block a claim carries (200 rows at most, no unknown key)", () => {
    expect(HeartbeatMessage.safeParse({ run_id: RUN, lease_generation: 1 }).success).toBe(true);
    expect(HeartbeatMessage.safeParse({ run_id: RUN, lease_generation: 1, sandboxes: [row] }).success).toBe(true);
    expect(HeartbeatMessage.safeParse({ run_id: RUN, lease_generation: 1, sandboxes: [] }).success).toBe(true);
    expect(HeartbeatMessage.safeParse({ run_id: RUN, lease_generation: 1, sandboxes: [{ ...row, host: "x" }] }).success).toBe(false);
    expect(HeartbeatMessage.safeParse({ run_id: RUN, lease_generation: 1, sandboxes: Array.from({ length: 201 }, (_, i) => ({ ...row, name: `v${i}` })) }).success).toBe(false);
    expect(HeartbeatMessage.safeParse({ run_id: RUN, lease_generation: 1, extra: 1 }).success).toBe(false);
  });

  it("the reply's sandboxes_recorded can only be true", () => {
    const base = { continue: true, lease_expires_at: "2026-11-21T12:01:30.000Z" };
    expect(HeartbeatReply.safeParse(base).success).toBe(true);
    expect(HeartbeatReply.safeParse({ ...base, sandboxes_recorded: true }).success).toBe(true);
    expect(HeartbeatReply.safeParse({ ...base, sandboxes_recorded: false }).success).toBe(false);
  });

  it("a hello may declare it at protocol 21 or later, and not below", () => {
    expect(HelloMessage.safeParse({ ...hello, protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL, capabilities: [HEARTBEAT_INVENTORY_HELLO_CAPABILITY] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL - 1, capabilities: [HEARTBEAT_INVENTORY_HELLO_CAPABILITY] }).success).toBe(false);
  });
});
