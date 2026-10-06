// apps/workspace/test/runs-storage.test.mjs
//
// D#37 WS-F2a: the Runs app's data side against a fake get(). The bodies are the
// repo's contract fixtures or small synthetic pages.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLive } from "../shell/core/cloud-live.js";
import { EVENT_CAP, LIST_LIMIT, coalesce, formatUsd, isLiveStatus, isTruncated, isUuid, loadRun, loadRunDetail, loadRunEvent, loadRunEvents, loadRunsPage, mergeFirstPage, upsertRow, watchAccount } from "../apps/runs/runs-storage.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listRuns", "200-page.json");
const RUN = fx("getRun", "200-running.json");
const EVENTS = fx("listRunEvents", "200-page.json");
const ID = RUN.id;

/** A fake get(): logs every call; `reply(url)` returns the body or throws. */
function fakeGet(reply) {
  const calls = [];
  const get = async (method, url) => {
    calls.push(`${method} ${url}`);
    return structuredClone(reply(url));
  };
  get.calls = calls;
  return get;
}

/** n synthetic events in pages of at most `limit`, with a cursor that is always resumable, as the real API's is. */
const source = (n) => (url) => {
  const limit = Number(/limit=(\d+)/.exec(url)[1]);
  const after = /cursor=(\d+)/.exec(url);
  const from = after ? Number(after[1]) : 0;
  const data = Array.from({ length: Math.max(0, Math.min(limit, n - from)) }, (_, i) => ({ seq: from + i + 1, kind: "checkpoint", at: "2026-09-18T12:00:00.000Z", payload: {} }));
  return { data, next_cursor: String(from + data.length) };
};

describe("loadRunsPage", () => {
  it("first page: one GET with limit=50 and no cursor", async () => {
    const get = fakeGet(() => LIST);
    const page = await loadRunsPage("", get);
    expect(get.calls).toEqual(["GET /api/v1/runs?limit=50"]);
    expect(page.rows).toHaveLength(1);
    expect(page.next).toBe(LIST.next_cursor);
  });

  it("Show more sends the cursor, and a repeated or empty cursor ends the list", async () => {
    const get = fakeGet(() => LIST); // the fixture server answers every cursor with the same page
    const page = await loadRunsPage(LIST.next_cursor, get);
    expect(get.calls[0]).toBe("GET /api/v1/runs?limit=50&cursor=" + encodeURIComponent(LIST.next_cursor));
    expect(page.next).toBe("");
    expect((await loadRunsPage("", fakeGet(() => ({ data: [], next_cursor: "" })))).next).toBe("");
    expect((await loadRunsPage("", fakeGet(() => ({ data: [], next_cursor: null })))).next).toBe("");
  });

  it("drops rows without a UUID id", async () => {
    const page = await loadRunsPage("", fakeGet(() => ({ data: [{ id: "x" }, LIST.data[0], null], next_cursor: "" })));
    expect(page.rows.map((r) => r.id)).toEqual([LIST.data[0].id]);
  });

  it("rejects when the request fails", async () => {
    await expect(loadRunsPage("", async () => { throw new Error("x"); })).rejects.toThrow();
  });
});

describe("loadRunEvents", () => {
  it("the fixture is one page with an empty cursor: one request, not capped", async () => {
    const get = fakeGet(() => EVENTS);
    const out = await loadRunEvents(ID, get);
    expect(get.calls).toEqual([`GET /api/v1/runs/${ID}/events?limit=200`]);
    expect(out.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(out.capped).toBe(false);
  });

  it("follows next_cursor across pages and stops at a short page", async () => {
    const get = fakeGet(source(450));
    const out = await loadRunEvents(ID, get);
    expect(out.events).toHaveLength(450);
    expect(get.calls).toHaveLength(3);
    expect(get.calls[1]).toContain("cursor=200");
    expect(out.capped).toBe(false);
  });

  it("an empty page stops the loop even though its cursor is resumable", async () => {
    const get = fakeGet(source(400)); // two full pages, then an empty third
    const out = await loadRunEvents(ID, get);
    expect(out.events).toHaveLength(400);
    expect(get.calls).toHaveLength(3);
  });

  it("caps at 2,000 events and reports it only when more exist", async () => {
    const over = fakeGet(source(EVENT_CAP + 1));
    const out = await loadRunEvents(ID, over);
    expect(out.events).toHaveLength(EVENT_CAP);
    expect(out.capped).toBe(true);
    const exact = await loadRunEvents(ID, fakeGet(source(EVENT_CAP)));
    expect(exact.events).toHaveLength(EVENT_CAP);
    expect(exact.capped).toBe(false);
  });

  it("a cursor that never moves ends the loop", async () => {
    const stuck = fakeGet(() => ({ data: source(400)("limit=200").data, next_cursor: "same" }));
    const out = await loadRunEvents(ID, stuck);
    expect(out.events.length).toBeLessThanOrEqual(400);
    expect(stuck.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("loadRunDetail", () => {
  it("one GET for the run and the paged events", async () => {
    const get = fakeGet((url) => (url.includes("/events") ? EVENTS : RUN));
    const d = await loadRunDetail(ID, get);
    expect(get.calls.filter((c) => c === `GET /api/v1/runs/${ID}`)).toHaveLength(1);
    expect(get.calls.filter((c) => c.includes("/events"))).toHaveLength(1);
    expect(d.run.id).toBe(ID);
    expect(d.events).toHaveLength(9);
  });

  it("rejects when either request fails", async () => {
    await expect(loadRunDetail(ID, fakeGet((url) => { if (url.includes("/events")) throw new Error("x"); return RUN; }))).rejects.toThrow();
    await expect(loadRunDetail(ID, fakeGet((url) => { if (!url.includes("/events")) throw new Error("x"); return EVENTS; }))).rejects.toThrow();
  });
});

describe("WS-F2c", () => {
  it("clamps a list page to the requested limit before it is stored", async () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ ...LIST.data[0], id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    const page = await loadRunsPage("", fakeGet(() => ({ data, next_cursor: "" })));
    expect(page.rows).toHaveLength(LIST_LIMIT);
    expect(page.rows[49].id).toBe(data[49].id);
  });

  it("once the run read fails, no new events page starts", async () => {
    const calls = [];
    const get = async (method, url) => {
      calls.push(url);
      if (!url.includes("/events")) throw new Error("404");
      await new Promise((r) => setTimeout(r, 5)); // the run read fails while this page is in flight
      return source(450)(url);
    };
    await expect(loadRunDetail(ID, get)).rejects.toThrow("404");
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.filter((u) => u.includes("/events"))).toHaveLength(1); // the in-flight one; its result is dropped
  });

  it("a caller's abort reaches the events loop too", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(loadRunEvents(ID, fakeGet(source(450)), ac.signal)).rejects.toThrow();
  });
});

describe("small helpers", () => {
  it("formatUsd: two places, an em dash for null, four places for a fraction of a cent", () => {
    expect(formatUsd(1.25)).toBe("$1.25");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd("1")).toBe("—");
  });

  it("isUuid", () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid("../x")).toBe(false);
    expect(isUuid(5)).toBe(false);
  });
});

// ── WS-F2b: the live helpers ───────────────────────────────────────────────
describe("isLiveStatus / isTruncated", () => {
  it("only pending and running open a stream; terminal and unknown statuses do not", () => {
    expect(["pending", "running"].every(isLiveStatus)).toBe(true);
    for (const s of ["succeeded", "failed", "cancelled", "timed_out", "killed_spend", "refused_spend", "killed_other", "weird", "", undefined]) expect(isLiveStatus(s)).toBe(false);
  });
  it("a truncated marker is exactly {truncated: true, original_bytes: N}", () => {
    expect(isTruncated({ truncated: true, original_bytes: 70000 })).toBe(true);
    for (const p of [{ truncated: true }, { truncated: true, original_bytes: "9" }, { truncated: "true", original_bytes: 9 }, { truncated: true, original_bytes: 9, x: 1 }, null, [], "s", undefined]) expect(isTruncated(p)).toBe(false);
  });
});

describe("loadRunEvent (the truncated-frame re-read)", () => {
  const full = { seq: 4, kind: "agent.output", at: "2026-09-18T12:00:00.000Z", payload: { text: "whole" } };
  it("reads one row after seq-1 and returns it when the seq matches", async () => {
    const get = fakeGet(() => ({ data: [full], next_cursor: "4" }));
    expect(await loadRunEvent(ID, 4, get)).toEqual(full);
    expect(get.calls).toEqual([`GET /api/v1/runs/${ID}/events?after_seq=3&limit=1`]);
  });
  it("is null for an empty page or a different seq, and rejects when the request fails", async () => {
    expect(await loadRunEvent(ID, 4, fakeGet(() => ({ data: [], next_cursor: "3" })))).toBeNull();
    expect(await loadRunEvent(ID, 4, fakeGet(() => ({ data: [{ ...full, seq: 5 }] })))).toBeNull();
    await expect(loadRunEvent(ID, 4, async () => { throw new Error("x"); })).rejects.toThrow();
  });
  it("loadRun is one GET of the run", async () => {
    const get = fakeGet(() => RUN);
    expect((await loadRun(ID, get)).id).toBe(RUN.id);
    expect(get.calls).toEqual([`GET /api/v1/runs/${ID}`]);
  });
});

describe("row helpers", () => {
  const a = { id: "a", status: "running" }, b = { id: "b", status: "running" };
  it("upsertRow replaces a row where it is, or adds the run at the top; the input is untouched", () => {
    const rows = [a, b];
    expect(upsertRow(rows, { id: "b", status: "succeeded" })).toEqual([a, { id: "b", status: "succeeded" }]);
    expect(upsertRow(rows, { id: "c" })).toEqual([{ id: "c" }, a, b]);
    expect(rows).toEqual([a, b]);
  });
  it("mergeFirstPage puts the fresh page on top and keeps rows Show more had added", () => {
    const fresh = [{ id: "n" }, { id: "a", status: "succeeded" }];
    expect(mergeFirstPage([a, b, { id: "z" }], fresh)).toEqual([{ id: "n" }, { id: "a", status: "succeeded" }, b, { id: "z" }]);
  });
});

describe("coalesce", () => {
  afterEach(() => vi.useRealTimers());
  it("5 triggers in 1 s run the function twice; a later trigger starts a new window", () => {
    vi.useFakeTimers();
    const fn = vi.fn(), go = coalesce(fn, 1000);
    for (let i = 0; i < 5; i++) { go(); vi.advanceTimersByTime(150); }
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(2);
    go();
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("cancel() drops the pending trailing run", () => {
    vi.useFakeTimers();
    const fn = vi.fn(), go = coalesce(fn, 1000);
    go(); go(); go.cancel(); vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("watchAccount", () => {
  const UUID = "3f2b8c1e-0000-4000-8000-000000000009";
  /** A live stand-in that keeps the handlers so a test can fire them. */
  function fakeLive() {
    const l = { subs: new Map(), refresh: new Set() };
    l.on = (t, h) => { l.subs.set(t, (l.subs.get(t) || new Set()).add(h)); return () => l.subs.get(t).delete(h); };
    l.onRefresh = (h) => { l.refresh.add(h); return () => l.refresh.delete(h); };
    l.fire = (dto) => (l.subs.get(dto.type) || []).forEach((h) => h(dto));
    return l;
  }
  it("run.status_changed passes the run id when it is a UUID; anything else is ignored", () => {
    const live = fakeLive(), onStatus = vi.fn();
    watchAccount({ onStatus, onRefresh: () => {} }, live);
    live.fire({ type: "run.status_changed", data: { runId: UUID } });
    for (const runId of ["x", "a/b?c", "", 7, null, undefined, "3f2b8c1e-0000-4000-8000-00000000000g"]) live.fire({ type: "run.status_changed", data: { runId } });
    live.fire({ type: "run.status_changed" });
    live.fire({ type: "run.status_changed", data: null });
    expect(onStatus.mock.calls).toEqual([[UUID]]);
  });
  it("a refresh reaches the app's handler; the unsubscribe drops both subscriptions", () => {
    const live = fakeLive(), onStatus = vi.fn(), refresh = vi.fn();
    const off = watchAccount({ onStatus, onRefresh: refresh }, live);
    live.refresh.forEach((h) => h());
    expect(refresh).toHaveBeenCalledTimes(1);
    off();
    live.refresh.forEach((h) => h());
    live.fire({ type: "run.status_changed", data: { runId: UUID } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled();
  });
  it("20 subscribe/unsubscribe cycles leave the shell live client's subscriberCount at its baseline", () => {
    const live = createLive({ win: { addEventListener() {}, removeEventListener() {} }, doc: null, fetch: async () => ({ status: 500 }), locks: undefined, BroadcastChannel: undefined });
    const base = live.subscriberCount();
    for (let i = 0; i < 20; i++) {
      const off = watchAccount({ onStatus() {}, onRefresh() {} }, live);
      expect(live.subscriberCount()).toBe(base + 2);
      off();
      expect(live.subscriberCount()).toBe(base);
    }
  });
});
