import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Text, type Job } from "../src/job.js";
import { signJob } from "../src/jobSignature.js";
import {
  CLAIM_IDLE_RETRY_AFTER_SECONDS,
  CLAIM_MIN_INTERVAL_SECONDS,
  CLAIM_QUEUED_RETRY_AFTER_SECONDS,
  ClaimRateLimitedReply,
  ClaimReply,
  ClaimedReply,
  DONE_RETRY_AFTER_SECONDS,
  DoneReply,
  DoneRetryReply,
  EventsReply,
  HeartbeatReply,
  RUNNER_LEASE_SECONDS,
  RUNNER_MAX_RUN_WALL_CLOCK_MS,
  RUNNER_REPLIES,
  STOP_REASONS,
  SeqNotIncreasingReply,
  StopReply,
} from "../src/replies.js";
import { g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const job: Job = {
  schema_version: 1,
  job_id: "1f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e",
  run_id: RUN,
  repo: { id: "2f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", owner: "acme", name: "app", private: true },
  role: "executor",
  mode: "local",
  spec: null,
  task: { kind: "implement", prompt: "do it", prompt_sha256: sha256Text("do it") },
  role_card: { text: "card", sha256: sha256Text("card") },
  role_tools_sha256: "a".repeat(64),
  continues: null,
  branch_prefix: "fx/",
  model_hint: null,
  issued_at: "2026-10-08T12:00:00.000Z",
  expires_at: "2026-10-11T12:00:00.000Z",
  key_id: "k1",
};
const signed = signJob(job, generateKeyPairSync("ed25519").privateKey);

describe("the lease-route replies (D#6 R2b-3)", () => {
  it("pins the constants the Spec gives", () => {
    expect(RUNNER_LEASE_SECONDS).toBe(90);
    expect(RUNNER_MAX_RUN_WALL_CLOCK_MS).toBe(2 * 60 * 60 * 1000);
    expect(CLAIM_MIN_INTERVAL_SECONDS).toBe(4);
    expect(CLAIM_IDLE_RETRY_AFTER_SECONDS).toBe(60);
    expect(CLAIM_QUEUED_RETRY_AFTER_SECONDS).toEqual({ min: 5, max: 15 });
  });

  it("an idle claim answers exactly { retry_after }", () => {
    expect(ClaimReply.safeParse({ retry_after: 60 }).success).toBe(true);
    expect(ClaimReply.safeParse({ retry_after: 60, run_id: RUN }).success).toBe(false);
    for (const bad of [0, -1, 1.5, "60", 4000]) expect(ClaimReply.safeParse({ retry_after: bad }).success, String(bad)).toBe(false);
    expect(ClaimReply.safeParse({}).success).toBe(false);
  });

  it("a claimed reply carries the signed job, its run id and a lease generation of at least 1", () => {
    const ok = { signed_job: signed, run_id: RUN, lease_generation: 1 };
    expect(ClaimedReply.safeParse(ok).success).toBe(true);
    expect(ClaimReply.safeParse(ok).success).toBe(true);
    expect(ClaimedReply.safeParse({ ...ok, lease_generation: 0 }).success).toBe(false);
    expect(ClaimedReply.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(ClaimedReply.safeParse({ signed_job: signed, run_id: RUN }).success).toBe(false);
    // The run id must be the job's own: a mismatched pair is refused rather than trusted.
    expect(ClaimedReply.safeParse({ ...ok, run_id: "3f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e" }).success).toBe(false);
    // A job that does not parse (a public repo) is not a claimed reply.
    expect(ClaimedReply.safeParse({ ...ok, signed_job: { ...signed, job: { ...signed.job, repo: { ...job.repo, private: false } } } }).success).toBe(false);
  });

  const LEASE_END = "2026-10-08T12:01:30.000Z";

  it("a heartbeat answers exactly { continue: true, lease_expires_at } with an ISO UTC time", () => {
    expect(HeartbeatReply.safeParse({ continue: true, lease_expires_at: LEASE_END }).success).toBe(true);
    for (const bad of [{ continue: true }, { continue: false, lease_expires_at: LEASE_END }, { continue: true, lease_expires_at: "tomorrow" }, { continue: true, lease_expires_at: "2026-10-08T12:01:30+02:00" }, { continue: true, lease_expires_at: LEASE_END, accepted: 1 }]) {
      expect(HeartbeatReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("an events reply counts what was written and what the database dropped", () => {
    const ok = { continue: true, accepted: 3, duplicates: 0, lease_expires_at: LEASE_END };
    expect(EventsReply.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, accepted: -1 }, { ...ok, duplicates: 1.5 }, { ...ok, continue: false }, { continue: true, lease_expires_at: LEASE_END }, { ...ok, conflicts: 1 }]) {
      expect(EventsReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("every stop answers { continue: false, reason } with a reason from the closed set", () => {
    expect([...STOP_REASONS]).toEqual(["stale_generation", "lease_expired", "run_terminal", "wall_clock_limit"]);
    for (const reason of STOP_REASONS) expect(StopReply.safeParse({ continue: false, reason }).success, reason).toBe(true);
    for (const bad of [{ continue: false }, { continue: false, reason: "revoked" }, { continue: true, reason: "run_terminal" }, { continue: false, reason: "run_terminal", why: "x" }]) {
      expect(StopReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("seq_not_increasing is not a stop: it keeps the runner going and names the last accepted number", () => {
    const ok = { continue: true, error: "seq_not_increasing", last_accepted_seq: 7 };
    expect(SeqNotIncreasingReply.safeParse(ok).success).toBe(true);
    expect(StopReply.safeParse(ok).success).toBe(false);
    for (const bad of [{ ...ok, continue: false }, { ...ok, last_accepted_seq: -1 }, { continue: true, error: "seq_not_increasing" }, { ...ok, error: "other" }]) {
      expect(SeqNotIncreasingReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("done answers the cloud's own outcome, or 503 { retry_after }", () => {
    expect(DoneReply.safeParse({ continue: false, outcome: "succeeded", failure_reason: null, pr_number: 12 }).success).toBe(true);
    expect(DoneReply.safeParse({ continue: false, outcome: "failed", failure_reason: "scope_violation", pr_number: null }).success).toBe(true);
    for (const bad of [{ continue: false, outcome: "succeeded" }, { continue: false, outcome: "timed_out", failure_reason: null, pr_number: null }, { continue: true, outcome: "failed", failure_reason: null, pr_number: null }, { continue: false, outcome: "failed", failure_reason: "Bad Reason", pr_number: null }, { continue: false, outcome: "succeeded", failure_reason: null, pr_number: 0 }]) {
      expect(DoneReply.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(DoneRetryReply.safeParse({ retry_after: DONE_RETRY_AFTER_SECONDS }).success).toBe(true);
    expect(DoneRetryReply.safeParse({ retry_after: 0 }).success).toBe(false);
    expect(DoneRetryReply.safeParse({}).success).toBe(false);
  });

  it("a rate-limited claim answers exactly { retry_after } of at most the interval", () => {
    expect(ClaimRateLimitedReply.safeParse({ retry_after: 3 }).success).toBe(true);
    expect(ClaimRateLimitedReply.safeParse({ retry_after: 5 }).success).toBe(false);
    expect(ClaimRateLimitedReply.safeParse({ retry_after: 0 }).success).toBe(false);
    expect(ClaimRateLimitedReply.safeParse({ error: { code: "rate_limited", message: "x" }, retry_after: 3 }).success).toBe(false);
    expect(ClaimRateLimitedReply.safeParse({}).success).toBe(false);
  });

  it("every reply is strict at every depth and passes G1", () => {
    expect(Object.keys(RUNNER_REPLIES).sort()).toEqual(["claim", "claim_rate_limited", "done", "done_retry", "events", "heartbeat", "seq_not_increasing", "stop"]);
    for (const [name, schema] of Object.entries(RUNNER_REPLIES)) {
      const walkable = schema as z.ZodTypeAny;
      // A union is walked member by member.
      const members = walkable instanceof z.ZodUnion ? (walkable.options as z.ZodTypeAny[]) : [walkable];
      for (const member of members) {
        expect(nonStrictObjects(member), name).toEqual([]);
        expect(g1Violations(member), name).toEqual([]);
      }
    }
  });
});
