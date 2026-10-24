import { describe, expect, it } from "vitest";
import { RUNNER_ONLINE_SECONDS, RUNNER_WAKE_LIVENESS_SECONDS, RUNNER_WORK_REPLY_SECONDS, runnerIgnoringWork, runnerIgnoringWorkSql, runnerIsLive, runnerLastHeardAt, runnerLiveSql, runnerLivenessSeconds } from "../src/index.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const ago = (s: number): Date => new Date(NOW.getTime() - s * 1000);

/** D#6 RUNNER-WAKE: the one liveness rule every runner-presence consumer shares. */
describe("runner liveness", () => {
  it("is 120 s for a plain runner and 35 min for a wake runner", () => {
    expect(RUNNER_WAKE_LIVENESS_SECONDS).toBe(2100);
    expect(runnerLivenessSeconds(false)).toBe(RUNNER_ONLINE_SECONDS);
    expect(runnerLivenessSeconds(undefined)).toBe(RUNNER_ONLINE_SECONDS);
    expect(runnerLivenessSeconds(true)).toBe(RUNNER_WAKE_LIVENESS_SECONDS);
  });

  it("an idle wake runner between slots is live; the same quiet plain runner is not", () => {
    expect(runnerIsLive({ lastSeenAt: ago(600), wakeCapable: true }, NOW)).toBe(true);
    expect(runnerIsLive({ lastSeenAt: ago(600) }, NOW)).toBe(false);
  });

  it("a dead runner (no cached stamp, database stamp past its window) is absent; both edges are inclusive", () => {
    expect(runnerIsLive({ lastSeenAt: ago(2101), wakeCapable: true, seenAt: null }, NOW)).toBe(false);
    expect(runnerIsLive({ lastSeenAt: ago(2100), wakeCapable: true }, NOW)).toBe(true);
    expect(runnerIsLive({ lastSeenAt: ago(121) }, NOW)).toBe(false);
    expect(runnerIsLive({ lastSeenAt: ago(120) }, NOW)).toBe(true);
    expect(runnerIsLive({ lastSeenAt: null }, NOW)).toBe(false);
  });

  it("the later of the database stamp and the cached wake check decides", () => {
    expect(runnerLastHeardAt({ lastSeenAt: ago(3000), seenAt: ago(30) })).toEqual(ago(30));
    expect(runnerLastHeardAt({ lastSeenAt: ago(30), seenAt: ago(3000) })).toEqual(ago(30));
    expect(runnerLastHeardAt({ lastSeenAt: null, seenAt: ago(30) })).toEqual(ago(30));
    expect(runnerIsLive({ lastSeenAt: ago(3000), seenAt: ago(30), wakeCapable: true }, NOW)).toBe(true);
    expect(runnerIsLive({ lastSeenAt: ago(3000), seenAt: ago(2200), wakeCapable: true }, NOW)).toBe(false);
  });

  it("the SQL predicate is the plain 120 s test with the wake gate closed, and adds the wake window for a wake_v1 runner when it is open", () => {
    const closed = runnerLiveSql({ runner: "r", now: "$2", onlineSeconds: "$3", wakeEnabled: false });
    expect(closed).toBe("r.last_seen_at >= $2::timestamptz - make_interval(secs => $3)");
    const open = runnerLiveSql({ runner: "r", now: "$2", wakeEnabled: true });
    expect(open).toContain(`make_interval(secs => ${RUNNER_ONLINE_SECONDS})`);
    expect(open).toContain(`make_interval(secs => ${RUNNER_WAKE_LIVENESS_SECONDS})`);
    expect(open).toContain("'wake_v1' = ANY(wake_cap.capabilities)");
  });

  it("the SQL predicate takes only an alias and placeholders, never text that could carry input", () => {
    expect(() => runnerLiveSql({ runner: "r; DROP", now: "$2", wakeEnabled: true })).toThrow();
    expect(() => runnerLiveSql({ runner: "r", now: "now()", wakeEnabled: true })).toThrow();
    expect(() => runnerLiveSql({ runner: "r", now: "$2", onlineSeconds: "120 OR true", wakeEnabled: true })).toThrow();
  });
});

/** D#6 PING-CONSUMERS: the reply-aware addition. The SQL/TS parity table runs against Postgres in packages/worker/test/runnerReplyAware.pg.test.ts. */
describe("runner liveness, reply-aware", () => {
  const base = { lastSeenAt: ago(600), latestLeaseExpiresAt: null, wakeCapable: true, sandboxDown: false, heldBack: false };
  const work = (anchorAge: number, claimableAfterAge: number | null = null) => [{ claimableSince: ago(anchorAge), claimableAfter: claimableAfterAge === null ? null : ago(claimableAfterAge) }];

  it("flags a wake runner at exactly 90 s of unanswered work, not at 89", () => {
    expect(RUNNER_WORK_REPLY_SECONDS).toBe(90);
    expect(runnerIgnoringWork({ ...base, pending: work(89) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, pending: work(90) }, NOW)).toBe(true);
  });

  it("an answer after the anchor, or a lease extended after it, clears the flag; missing inputs flag nothing", () => {
    expect(runnerIgnoringWork({ ...base, lastSeenAt: ago(100), pending: work(200) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, latestLeaseExpiresAt: new Date(ago(200).getTime() + 100_000), pending: work(200) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, lastSeenAt: null, pending: work(200) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, pending: [] }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, wakeCapable: false, pending: work(200) }, NOW)).toBe(false);
  });

  it("the anchor is the later of claimable_since and claimable_after", () => {
    expect(runnerIgnoringWork({ ...base, pending: work(500, -60) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, pending: work(500, 89) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, pending: work(500, 90) }, NOW)).toBe(true);
  });

  it("a runner that is down on purpose is quiet", () => {
    expect(runnerIgnoringWork({ ...base, sandboxDown: true, pending: work(200) }, NOW)).toBe(false);
    expect(runnerIgnoringWork({ ...base, heldBack: true, pending: work(200) }, NOW)).toBe(false);
  });

  it("the live predicate gains the rule only when asked and only with the wake gate open", () => {
    const plain = runnerLiveSql({ runner: "r", now: "$2", wakeEnabled: true });
    const aware = runnerLiveSql({ runner: "r", now: "$2", wakeEnabled: true, replyAware: true });
    expect(aware).toBe(`(${plain} AND NOT ${runnerIgnoringWorkSql({ runner: "r", now: "$2" })})`);
    expect(runnerLiveSql({ runner: "r", now: "$2", onlineSeconds: "$3", wakeEnabled: false, replyAware: true })).toBe("r.last_seen_at >= $2::timestamptz - make_interval(secs => $3)");
    expect(() => runnerIgnoringWorkSql({ runner: "r; DROP", now: "$2" })).toThrow();
    expect(() => runnerIgnoringWorkSql({ runner: "r", now: "now()" })).toThrow();
  });
});
