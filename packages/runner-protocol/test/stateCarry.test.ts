import { describe, expect, it } from "vitest";
import { ENGINE_CARRY_CAPABILITY, PLATFORM_FACT_HELLO_CAPABILITY, RUNNER_CAPABILITIES, TWIN_CAPABILITY } from "../src/job.js";
import { MachineJob } from "../src/machineJobs.js";
import {
  STATE_CARRY_CHUNK_BYTES,
  STATE_CARRY_MAX_BYTES,
  STATE_CARRY_MAX_CHUNKS,
  StartCarryArgs,
  StateCarryBeginBody,
  StateCarryFailBody,
  stateCarryChunkCount,
  stateCarryChunkPath,
  stateCarryChunkSize,
} from "../src/stateCarry.js";

const NOW = new Date("2026-11-27T15:00:00Z");
const at = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();
const ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const CARRY = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const SHA40 = "a".repeat(40);
const HEX = "b".repeat(64);
const base = { v: 1, job_id: ID, runner_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", repo_gh_id: 77, requires_engine: "microvm", issued_at: at(0), expires_at: at(600) };
const stop = (args: Record<string, unknown>) => ({ ...base, kind: "engine_session_stop", args: { reason: "move", operate_epoch: 1, ...args } });
const start = (args: Record<string, unknown>) => ({ ...base, kind: "engine_session_start", args: { at_sha: SHA40, resume: false, operate_epoch: 1, ...args } });
const ok = (value: unknown): boolean => MachineJob.safeParse(value).success;
const carry = { id: CARRY, bytes: STATE_CARRY_CHUNK_BYTES + 5, chunks: 2, sha256: HEX };

describe("engine_carry_v1 (D#845 MC-9b2)", () => {
  it("is after twin_v1 and platform_fact_v1, directly before gh_login_v1 (D#845 ON-19c, the newest), and on the hello's closed list", () => {
    expect(RUNNER_CAPABILITIES.indexOf("gh_login_v1")).toBe(RUNNER_CAPABILITIES.indexOf(ENGINE_CARRY_CAPABILITY) + 1);
    expect(RUNNER_CAPABILITIES.indexOf("gh_login_v1")).toBe(RUNNER_CAPABILITIES.length - 1);
    expect(RUNNER_CAPABILITIES.indexOf(ENGINE_CARRY_CAPABILITY)).toBeGreaterThan(RUNNER_CAPABILITIES.indexOf(TWIN_CAPABILITY));
    expect(RUNNER_CAPABILITIES.indexOf(ENGINE_CARRY_CAPABILITY)).toBeGreaterThan(RUNNER_CAPABILITIES.indexOf(PLATFORM_FACT_HELLO_CAPABILITY));
  });

  it("takes a carry on a move stop (its id alone) and on a start that does not resume (the whole fact), and each is optional", () => {
    expect(ok(stop({}))).toBe(true);
    expect(ok(stop({ carry: { id: CARRY } }))).toBe(true);
    expect(ok(start({}))).toBe(true);
    expect(ok(start({ carry }))).toBe(true);
  });

  it("refuses a carry on any stop that is not a move, and on a start that resumes", () => {
    for (const reason of ["person", "halt", "remove", "operate_off", "plan"]) expect(ok(stop({ reason, carry: { id: CARRY } })), reason).toBe(false);
    expect(ok(start({ resume: true, carry }))).toBe(false);
  });

  it("refuses a carry whose chunk count does not match its size, a size outside 1 byte to 50 MiB, a key it does not know and an id that is not a uuid", () => {
    expect(ok(start({ carry: { ...carry, chunks: 1 } }))).toBe(false);
    expect(ok(start({ carry: { ...carry, chunks: 3 } }))).toBe(false);
    expect(ok(start({ carry: { ...carry, bytes: 0, chunks: 0 } }))).toBe(false);
    expect(ok(start({ carry: { ...carry, bytes: STATE_CARRY_MAX_BYTES + 1, chunks: STATE_CARRY_MAX_CHUNKS + 1 } }))).toBe(false);
    expect(ok(start({ carry: { ...carry, bytes: STATE_CARRY_MAX_BYTES, chunks: STATE_CARRY_MAX_CHUNKS } }))).toBe(true);
    expect(ok(start({ carry: { ...carry, extra: 1 } }))).toBe(false);
    expect(ok(start({ carry: { ...carry, sha256: "B".repeat(64) } }))).toBe(false);
    expect(ok(stop({ carry: { id: "not-a-uuid" } }))).toBe(false);
    expect(ok(stop({ carry: { id: CARRY, bytes: 1 } }))).toBe(false);
  });

  it("holds the sizes: 13 chunks of 4 MiB cover 50 MiB, every chunk but the last is exactly 4 MiB, and the last is the remainder", () => {
    expect(STATE_CARRY_MAX_CHUNKS * STATE_CARRY_CHUNK_BYTES).toBeGreaterThanOrEqual(STATE_CARRY_MAX_BYTES);
    expect(stateCarryChunkCount(STATE_CARRY_MAX_BYTES)).toBe(STATE_CARRY_MAX_CHUNKS);
    expect(stateCarryChunkCount(STATE_CARRY_CHUNK_BYTES)).toBe(1);
    expect(stateCarryChunkCount(STATE_CARRY_CHUNK_BYTES + 1)).toBe(2);
    expect([0, 1].map((i) => stateCarryChunkSize(STATE_CARRY_CHUNK_BYTES + 5, i))).toEqual([STATE_CARRY_CHUNK_BYTES, 5]);
  });

  it("has strict route messages and a path that names the job and the chunk", () => {
    expect(StateCarryBeginBody.safeParse({ bytes: 10, chunks: 1, sha256: HEX }).success).toBe(true);
    expect(StateCarryBeginBody.safeParse({ bytes: 10, chunks: 2, sha256: HEX }).success).toBe(false);
    expect(StateCarryBeginBody.safeParse({ bytes: 10, chunks: 1, sha256: HEX, extra: 1 }).success).toBe(false);
    expect(StartCarryArgs.safeParse(carry).success).toBe(true);
    for (const code of ["too_large", "link", "export_failed"]) expect(StateCarryFailBody.safeParse({ code }).success, code).toBe(true);
    for (const code of ["expired", "import_failed", "", "other"]) expect(StateCarryFailBody.safeParse({ code }).success, code).toBe(false);
    expect(stateCarryChunkPath(ID, 3)).toBe(`/api/runner/machine-job/${ID}/carry/chunk/3`);
  });
});
