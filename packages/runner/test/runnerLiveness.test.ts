import { describe, expect, it } from "vitest";
import { RUNNER_ONLINE_SECONDS, RUNNER_WAKE_LIVENESS_SECONDS, runnerIsLive, runnerLastHeardAt, runnerLiveSql, runnerLivenessSeconds } from "../src/index.js";

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
