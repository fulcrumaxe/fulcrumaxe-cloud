import { describe, expect, it } from "vitest";
import type { RepoTokenResult } from "../../src/daemon/client.js";
import { REPO_TOKEN_FIRST_MS, REPO_TOKEN_MAX_FAILURES, REPO_TOKEN_REFRESH_MS, REPO_TOKEN_RETRY_MS, createRepoTokenRefresher } from "../../src/engineSession/repoToken.js";

/**
 * D#845 ON-18: the repo token's refresh loop. The clock is a list of timers the test fires by hand, the cloud is a queue of answers, and the guest is a function that records the bytes it was given (and the buffer, to
 * see it zeroed). Nothing here reaches a network, a guest or a real clock.
 */
const SESSION = "11111111-1111-4111-8111-111111111111";
const GH = 77;
const SECRET = "ghs_sentinel_refresh_token_0123456789";
const token = (text = SECRET): RepoTokenResult => ({ kind: "token", token: text, expiresAt: "2026-11-27T20:00:00.000Z" });
const refused: RepoTokenResult = { kind: "refused", status: 409, code: "session_not_running" };
const noRoute: RepoTokenResult = { kind: "refused", status: 404 }; // an older cloud: a 404 with none of the route's own codes
const unknownRepo: RepoTokenResult = { kind: "refused", status: 404, code: "not_found" };
const down: RepoTokenResult = { kind: "error", status: 0, code: "network" };

function rig(answers: Array<RepoTokenResult | Error>, opts: { enabled?: boolean; revokeFails?: boolean; report?: "reported" | "refused" | "throws" } = {}) {
  const reports: Array<[number, string]> = [];
  const revoked: string[] = [];
  const order: string[] = [];
  const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
  const asked: Array<[number, string]> = [];
  const put: Array<{ text: string; buffer: Buffer }> = [];
  const lines: string[] = [];
  const exhausted: number[] = [];
  let guestFails = false;
  const refresher = createRepoTokenRefresher({
    client: {
      engineRepoTokenStop: async (repo, session) => {
        order.push("report");
        reports.push([repo, session]);
        if (opts.report === "throws") throw new Error("down");
        return opts.report === "refused" ? { kind: "refused", status: 409, code: "session_not_running" } : { kind: "reported", result: "recorded" };
      },
      engineRepoToken: async (repo, session) => {
        asked.push([repo, session]);
        const next = answers.shift() ?? refused;
        if (next instanceof Error) throw next;
        return next;
      },
    },
    after: (ms, fn) => {
      const timer = { ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    exhausted: (repo) => {
      order.push("stop");
      exhausted.push(repo);
    },
    log: (line) => void lines.push(line),
    ...(opts.enabled === undefined ? {} : { enabled: () => opts.enabled === true }),
    revoke: async (t) => {
      order.push(`revoke:${t}`);
      revoked.push(t);
      if (opts.revokeFails === true) throw new Error("boom ghs_leak");
      return true;
    },
  });
  const begin = () =>
    refresher.begin(GH, SESSION, async (buffer) => {
      if (guestFails) throw new Error("channel down");
      order.push(`put:${buffer.toString("latin1")}`);
      put.push({ text: buffer.toString("latin1"), buffer });
    });
  /** Fires the one live timer and lets the async attempt finish. */
  const fire = async (): Promise<number | undefined> => {
    const timer = timers.filter((t) => t.live).at(-1);
    if (timer === undefined) return undefined;
    timer.live = false;
    timer.fn();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return timer.ms;
  };
  const live = () => timers.filter((t) => t.live).map((t) => t.ms);
  return { refresher, begin, fire, live, asked, put, lines, exhausted, revoked, order, reports, failGuest: () => void (guestFails = true) };
}

describe("the repo token refresh loop", () => {
  it("asks first shortly after the start, hands the token to the guest, zeroes its buffer, and asks again at 45 minutes", async () => {
    const r = rig([token(), token("ghs_second")]);
    r.begin();
    expect(r.live()).toEqual([REPO_TOKEN_FIRST_MS]);
    expect(await r.fire()).toBe(REPO_TOKEN_FIRST_MS);
    expect(r.asked).toEqual([[GH, SESSION]]);
    expect(r.put.map((p) => p.text)).toEqual([SECRET]);
    expect(r.put[0]!.buffer.every((b) => b === 0)).toBe(true);
    expect(r.live()).toEqual([REPO_TOKEN_REFRESH_MS]);
    expect(REPO_TOKEN_REFRESH_MS).toBe(45 * 60_000);
    await r.fire();
    expect(r.put.map((p) => p.text)).toEqual([SECRET, "ghs_second"]);
    expect(r.live()).toEqual([REPO_TOKEN_REFRESH_MS]);
  });

  it("a failed ask is tried again a minute later, and one success in between starts the count over", async () => {
    const r = rig([refused, refused, token(), refused, refused, token()]);
    r.begin();
    await r.fire();
    expect(r.live()).toEqual([REPO_TOKEN_RETRY_MS]);
    await r.fire();
    expect(r.live()).toEqual([REPO_TOKEN_RETRY_MS]);
    await r.fire(); // the third ask succeeds: two failures never ended the session
    expect(r.live()).toEqual([REPO_TOKEN_REFRESH_MS]);
    await r.fire();
    await r.fire();
    await r.fire();
    expect(r.exhausted).toEqual([]);
    expect(r.put).toHaveLength(2);
    expect(r.live()).toEqual([REPO_TOKEN_REFRESH_MS]);
  });

  it("three failed asks in a row end the loop and stop the session, once, and ask no more", async () => {
    const r = rig([refused, down, new Error("socket hang up")]);
    r.begin();
    for (let i = 0; i < REPO_TOKEN_MAX_FAILURES; i++) await r.fire();
    expect(r.exhausted).toEqual([GH]);
    expect(r.live()).toEqual([]);
    expect(r.asked).toHaveLength(3);
    expect(await r.fire()).toBeUndefined();
    expect(r.lines).toEqual([expect.stringContaining("token_refresh_failed")]);
    expect(r.lines.join("\n")).not.toMatch(/hang up|ghs_/);
  });

  it("a guest that does not take the token counts as a failed ask, and the three-strike stop follows", async () => {
    const r = rig([token(), token(), token()]);
    r.failGuest();
    r.begin();
    for (let i = 0; i < REPO_TOKEN_MAX_FAILURES; i++) await r.fire();
    expect(r.exhausted).toEqual([GH]);
    expect(r.put).toEqual([]);
  });

  it("the failure after a long run of successes is a first failure, not a third", async () => {
    const r = rig([token(), token(), token(), refused]);
    r.begin();
    for (let i = 0; i < 4; i++) await r.fire();
    expect(r.live()).toEqual([REPO_TOKEN_RETRY_MS]);
    expect(r.exhausted).toEqual([]);
  });

  it("`end` cancels the pending ask, and an ask already in flight puts nothing into the session and counts nothing", async () => {
    const r = rig([token(), refused]);
    r.begin();
    r.refresher.end(GH);
    expect(r.live()).toEqual([]);
    // an ask that was in flight when the stop came
    const second = rig([token()]);
    second.begin();
    const timer = second.live();
    expect(timer).toEqual([REPO_TOKEN_FIRST_MS]);
    const pending = second.fire();
    second.refresher.end(GH);
    await pending;
    expect(second.put).toEqual([]);
    expect(second.revoked).toEqual([SECRET]); // minted after the stop: not kept
    expect(second.exhausted).toEqual([]);
    expect(second.live()).toEqual([]);
  });

  it("a newer `begin` for the same repository replaces the loop: the old one never asks again, with the old session id", async () => {
    const r = rig([token(), token()]);
    r.begin();
    r.refresher.begin(GH, "22222222-2222-4222-8222-222222222222", async () => undefined);
    expect(r.live()).toEqual([REPO_TOKEN_FIRST_MS]);
    await r.fire();
    expect(r.asked).toEqual([[GH, "22222222-2222-4222-8222-222222222222"]]);
  });

  it("two repositories keep their own loops", async () => {
    const r = rig([token(), token()]);
    r.begin();
    r.refresher.begin(GH + 1, SESSION, async () => undefined);
    r.refresher.end(GH);
    expect(r.live()).toEqual([REPO_TOKEN_FIRST_MS]);
    await r.fire();
    expect(r.asked).toEqual([[GH + 1, SESSION]]);
  });

  it("starts no loop at all when the cloud did not accept the capability: nothing is asked, nothing stops", async () => {
    const r = rig([token(), refused, refused, refused], { enabled: false });
    r.begin();
    expect(r.live()).toEqual([]);
    expect(await r.fire()).toBeUndefined();
    expect(r.asked).toEqual([]);
    expect(r.exhausted).toEqual([]);
    expect(r.lines).toEqual([]);
  });

  it("revokes the token a refresh replaces only after the new one is in the guest, and the current one when the loop ends", async () => {
    const r = rig([token("ghs_one_0123456789"), token("ghs_two_0123456789")]);
    r.begin();
    await r.fire();
    expect(r.revoked).toEqual([]);
    await r.fire();
    expect(r.order).toEqual(["put:ghs_one_0123456789", "put:ghs_two_0123456789", "revoke:ghs_one_0123456789"]);
    r.refresher.end(GH);
    expect(r.revoked).toEqual(["ghs_one_0123456789", "ghs_two_0123456789"]);
    r.refresher.end(GH); // a second end revokes nothing again
    expect(r.revoked).toHaveLength(2);
  });

  it("a token the guest did not take is revoked at once, the held one stays until the loop ends, and three strikes revoke it once", async () => {
    const r = rig([token("ghs_one_0123456789"), token("ghs_two_0123456789"), refused, refused, refused]);
    r.begin();
    await r.fire();
    r.failGuest();
    await r.fire();
    expect(r.revoked).toEqual(["ghs_two_0123456789"]);
    await r.fire();
    await r.fire();
    expect(r.exhausted).toEqual([GH]);
    expect(r.revoked).toEqual(["ghs_two_0123456789", "ghs_one_0123456789"]);
  });

  it("a revoke that fails is logged with a fixed code and nothing of the cause, and changes nothing else", async () => {
    const r = rig([token("ghs_one_0123456789")], { revokeFails: true });
    r.begin();
    await r.fire();
    r.refresher.end(GH);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.lines).toEqual(["fx-runner: a repository token could not be revoked (repo_token_revoke_failed)"]);
    expect(r.lines.join("")).not.toMatch(/ghs_|boom/);
  });

  it("tells the cloud before it stops the session: one report, with the repository and the session, then the local stop", async () => {
    const r = rig([refused, refused, refused]);
    r.begin();
    for (let i = 0; i < REPO_TOKEN_MAX_FAILURES; i++) await r.fire();
    expect(r.reports).toEqual([[GH, SESSION]]);
    expect(r.order.filter((o) => o === "report" || o === "stop")).toEqual(["report", "stop"]);
    expect(r.exhausted).toEqual([GH]);
  });

  it("a report the cloud refuses or cannot take still lets the session stop, and says so with a fixed code", async () => {
    for (const report of ["refused", "throws"] as const) {
      const r = rig([refused, refused, refused], { report });
      r.begin();
      for (let i = 0; i < REPO_TOKEN_MAX_FAILURES; i++) await r.fire();
      expect(r.exhausted, report).toEqual([GH]);
      expect(r.lines.join("\n"), report).toContain("repo_token_stop_unreported");
      expect(r.lines.join("\n"), report).not.toMatch(/down|ghs_/);
    }
  });

  it("two failures and a success report nothing, and nothing is reported before the third in a row", async () => {
    const r = rig([refused, refused, token(), refused, refused]);
    r.begin();
    for (let i = 0; i < 5; i++) await r.fire();
    expect(r.reports).toEqual([]);
    expect(r.exhausted).toEqual([]);
  });

  it("an older cloud (a 404 with none of the route's own codes) ends the loop quietly: no strike, no report, no stop", async () => {
    const r = rig([noRoute, token(), refused, refused, refused]);
    r.begin();
    await r.fire();
    expect(r.live()).toEqual([]);
    expect(await r.fire()).toBeUndefined();
    expect(r.asked).toHaveLength(1);
    expect(r.reports).toEqual([]);
    expect(r.exhausted).toEqual([]);
    expect(r.lines).toEqual([expect.stringContaining("repo_token_route_missing")]);
  });

  it("a 404 that carries the route's own not_found is the route answering about a repository, and counts as a failed ask", async () => {
    const r = rig([unknownRepo, unknownRepo, unknownRepo]);
    r.begin();
    for (let i = 0; i < REPO_TOKEN_MAX_FAILURES; i++) await r.fire();
    expect(r.exhausted).toEqual([GH]);
    expect(r.reports).toEqual([[GH, SESSION]]);
  });
});
