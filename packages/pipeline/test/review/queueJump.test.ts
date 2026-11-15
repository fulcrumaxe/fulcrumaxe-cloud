import { describe, expect, it } from "vitest";
import { decideQueueJump, DEFAULT_QUEUE_JUMP_MIN_MINUTES, parseQueueJumpSettings, QUEUE_JUMP_REASON } from "../../src/review/queueJump.js";

const REPOS = new Set(["Acme/Widgets"]);
const WHO = { accountId: "a1", repoId: "r1", owner: "acme", name: "widgets" };

/** A client that answers the throttle read; `minutes` null is "no jump fact inside the window". Every statement is kept. */
const clientAnswering = (minutes: number | null) => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  return { statements, query: (async (sql: string, params: unknown[]) => (statements.push({ sql, params }), { rows: [{ minutes: minutes === null ? null : String(minutes) }] })) as never };
};

describe("parseQueueJumpSettings", () => {
  it("defaults on, 50 minutes, repositories lower-cased", () => {
    const s = parseQueueJumpSettings({}, REPOS);
    expect(s).toEqual({ enabled: true, repos: new Set(["acme/widgets"]), minMinutes: DEFAULT_QUEUE_JUMP_MIN_MINUTES });
    expect(DEFAULT_QUEUE_JUMP_MIN_MINUTES).toBe(50);
  });
  it.each([["on", true], ["ON", true], ["", true], ["off", false], [" off ", false], ["0", false], ["false", false], ["yes please", false]])("FX_QUEUE_JUMP=%j reads enabled=%s (anything but on or off is off: a typo never reorders the queue)", (raw, enabled) => {
    expect(parseQueueJumpSettings({ FX_QUEUE_JUMP: raw }, REPOS).enabled).toBe(enabled);
  });
  it.each([["30", 30], ["1", 1], ["1440", 1440], ["0", 50], ["1441", 50], ["-5", 50], ["abc", 50], ["", 50], ["12.5", 50]])("FX_QUEUE_JUMP_MIN_MINUTES=%j reads %i", (raw, n) => {
    expect(parseQueueJumpSettings({ FX_QUEUE_JUMP_MIN_MINUTES: raw }, REPOS).minMinutes).toBe(n);
  });
});

describe("decideQueueJump", () => {
  const on = parseQueueJumpSettings({}, REPOS);

  it("a listed repository with no jump in the window: jump", async () => {
    const c = clientAnswering(null);
    expect(await decideQueueJump(on, c, WHO)).toBe("jump");
    // The throttle is read from the recorded facts of this account and repository, with this window.
    expect(c.statements).toHaveLength(1);
    expect(c.statements[0]!.params).toEqual(["a1", "r1", QUEUE_JUMP_REASON, 50]);
    expect(c.statements[0]!.sql).toContain("merge_enqueued");
  });
  it("a jump inside the window: throttled", async () => {
    expect(await decideQueueJump(on, clientAnswering(12), WHO)).toBe("throttled");
  });
  it("the switch off: none, and nothing is read", async () => {
    const c = clientAnswering(null);
    expect(await decideQueueJump(parseQueueJumpSettings({ FX_QUEUE_JUMP: "off" }, REPOS), c, WHO)).toBe("none");
    expect(c.statements).toEqual([]);
  });
  it("no settings wired: none", async () => {
    expect(await decideQueueJump(undefined, clientAnswering(null), WHO)).toBe("none");
  });
  it("a repository that is not listed (a customer's): none, and nothing is read", async () => {
    const c = clientAnswering(null);
    expect(await decideQueueJump(on, c, { ...WHO, owner: "someone", name: "else" })).toBe("none");
    expect(c.statements).toEqual([]);
  });
  it("the repository match ignores case, as GitHub does", async () => {
    expect(await decideQueueJump(on, clientAnswering(null), { ...WHO, owner: "ACME", name: "WIDGETS" })).toBe("jump");
  });
  it("a configured window is the one the read uses", async () => {
    const c = clientAnswering(null);
    await decideQueueJump(parseQueueJumpSettings({ FX_QUEUE_JUMP_MIN_MINUTES: "30" }, REPOS), c, WHO);
    expect(c.statements[0]!.params[3]).toBe(30);
  });
});
