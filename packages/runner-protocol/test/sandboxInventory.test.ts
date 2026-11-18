import { describe, expect, it } from "vitest";
import {
  CURRENT_PROTOCOL_VERSION, ClaimMessage, HelloMessage, RUNNER_MESSAGES, RunnerFacts, SANDBOX_INVENTORY_MAX_ROWS, SANDBOX_INVENTORY_MIN_PROTOCOL, SANDBOX_NAME_PATTERN, SANDBOX_STATES, SandboxInventory,
  SandboxInventoryRow,
} from "../src/messages.js";
import { nonStrictObjects } from "./helpers/schemaWalk.js";

const row = (over: Record<string, unknown> = {}) => ({ name: "dev-box-1", state: "running", created_at: "2026-11-01T10:00:00Z", last_used_at: "2026-11-02T10:00:00.250Z", disk_bytes: 4096, snapshot_count: 2, snapshot_age_s: 3600, ...over });
const hello = { protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox" };
const facts = { os: "linux", arch: "x64", mem_gb_bucket: 32, cpus: 12, sandbox_engine: "microvm" };

/** D#587 B-7a: the closed `sandboxes` block on a claim and the host limits on hello facts, gated on protocol 21. */
describe("sandbox inventory on the claim", () => {
  it("the gate is protocol 21 and the current version speaks it", () => {
    expect(SANDBOX_INVENTORY_MIN_PROTOCOL).toBe(21);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(SANDBOX_INVENTORY_MIN_PROTOCOL);
  });

  it("is optional: an older runner's claim still parses, and a claim with the block parses", () => {
    expect(ClaimMessage.safeParse({}).success).toBe(true);
    expect(ClaimMessage.safeParse({ sandboxes: [] }).success).toBe(true);
    expect(ClaimMessage.safeParse({ sandboxes: [row(), row({ name: "b", last_used_at: null, snapshot_age_s: null })] }).success).toBe(true);
  });

  it("is closed: every schema on the path is strict, and an unknown key on the block, a row or the claim is refused", () => {
    expect(nonStrictObjects(ClaimMessage)).toEqual([]);
    expect(nonStrictObjects(SandboxInventoryRow)).toEqual([]);
    expect(ClaimMessage.safeParse({ sandboxes: [row({ log_tail: "x" })] }).success).toBe(false);
    expect(ClaimMessage.safeParse({ sandboxes: [row({ path: "/srv/a" })] }).success).toBe(false);
    expect(ClaimMessage.safeParse({ sandboxes: [], inventory: [] }).success).toBe(false);
    // A row names all seven fields and nothing else.
    expect(Object.keys(SandboxInventoryRow.shape).sort()).toEqual(["created_at", "disk_bytes", "last_used_at", "name", "snapshot_age_s", "snapshot_count", "state"]);
    const { name: _omit, ...noName } = row();
    expect(SandboxInventoryRow.safeParse(noName).success).toBe(false);
  });

  it("takes the VM helper's sandbox id pattern for a name, and refuses anything else", () => {
    expect(SANDBOX_NAME_PATTERN.source).toBe("^[a-z0-9][a-z0-9-]{0,39}$");
    for (const name of ["a", "0", "dev-box-1", "a".repeat(40)]) expect(SandboxInventoryRow.safeParse(row({ name })).success, name).toBe(true);
    for (const name of ["", "A", "-a", "a_b", "a b", "a/b", "../x", "a".repeat(41), "a\n", "é"]) expect(SandboxInventoryRow.safeParse(row({ name })).success, JSON.stringify(name)).toBe(false);
  });

  it("states are a closed set, times are ISO instants, sizes are bounded non-negative integers", () => {
    for (const state of SANDBOX_STATES) expect(SandboxInventoryRow.safeParse(row({ state })).success, state).toBe(true);
    for (const bad of [{ created_at: "2026-02-30T00:00:00Z" }, { created_at: "2026-13-45T10:00:00Z" }, { created_at: "2026-01-01T25:61:61Z" }, { last_used_at: "2026-02-30T00:00:00Z" }, { created_at: "2026-11-01T10:00:00.1234567890Z" }, { created_at: "0000-01-01T00:00:00Z" }, { created_at: `2026-11-01T10:00:00Z${" ".repeat(40)}` }, { created_at: "x".repeat(5000) }, { created_at: "2026-11-01T10:00:00+02:00" }, { last_used_at: "2026-11-01T10:00:00.1234567890Z" }]) {
      expect(SandboxInventoryRow.safeParse(row(bad)).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    expect(SandboxInventoryRow.safeParse(row({ created_at: "2026-11-01T10:00:00.123456789Z" })).success).toBe(true);
    for (const bad of [{ state: "Running" }, { state: "" }, { state: "paused" }, { created_at: "yesterday" }, { created_at: null }, { disk_bytes: -1 }, { disk_bytes: 1.5 }, { disk_bytes: "9" }, { snapshot_count: 10_001 }, { snapshot_age_s: -1 }, { last_used_at: "2026-11-02" }]) {
      expect(SandboxInventoryRow.safeParse(row(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("holds at most 200 rows, each name once", () => {
    expect(SANDBOX_INVENTORY_MAX_ROWS).toBe(200);
    const many = (n: number) => Array.from({ length: n }, (_v, i) => row({ name: `s${i}` }));
    expect(SandboxInventory.safeParse(many(200)).success).toBe(true);
    expect(SandboxInventory.safeParse(many(201)).success).toBe(false);
    expect(SandboxInventory.safeParse([row(), row()]).success).toBe(false);
  });
});

describe("host limits on hello facts", () => {
  const limits = { max_vms: 4, max_vcpus: 16, max_memory_mb: 32768, bootable_templates: ["fx-agent"] };

  it("are optional, so an older hello is unchanged, and accepted from protocol 21", () => {
    expect(HelloMessage.safeParse({ ...hello, facts }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, facts: { ...facts, ...limits } }).success).toBe(true);
    expect(RunnerFacts.safeParse({ ...facts, ...limits }).success).toBe(true);
  });

  it("are refused from a hello that declares a lower protocol, in both directions", () => {
    expect(HelloMessage.safeParse({ ...hello, protocol_version: 20, facts: { ...facts, ...limits } }).success).toBe(false);
    expect(HelloMessage.safeParse({ ...hello, protocol_version: 20, facts }).success).toBe(true);
  });

  it("are closed: bounds, template ids and an unknown key", () => {
    expect(nonStrictObjects(RUNNER_MESSAGES.hello)).toEqual([]);
    for (const bad of [{ max_vms: 257 }, { max_vms: -1 }, { max_vcpus: 4097 }, { max_memory_mb: 1.5 }, { bootable_templates: ["Bad Id"] }, { bootable_templates: ["a", "a"] }, { bootable_templates: Array.from({ length: 9 }, (_v, i) => `t${i}`) }, { hostname: "box" }]) {
      expect(HelloMessage.safeParse({ ...hello, facts: { ...facts, ...bad } }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
