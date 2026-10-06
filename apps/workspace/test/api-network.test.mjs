// apps/workspace/test/api-network.test.mjs
//
// H4b: how api() behaves when the network or the server misbehaves -- deadlines, bounded jittered
// retries for reads only, the offline failure, server_error with a fixed sentence, and the 429 wait --
// plus the shell's offline bar. Time is vitest's fake clock; fetch is a stub.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiFailure,
  MAX_AUTO_WAIT_SECONDS,
  OFFLINE_MESSAGE,
  READ_DEADLINE_MS,
  SERVER_ERROR_MESSAGE,
  TIMEOUT_MESSAGE,
  WRITE_DEADLINE_MS,
  api,
  backoffMs,
} from "../apps/_lib/api.js";
import { createLive } from "../shell/core/cloud-live.js";

const KEY = "123e4567-e89b-42d3-a456-426614174000";

function reply(status, text = "", headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: async () => text,
  };
}
const never = () => new Promise(() => {});

describe("api() deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a read that never answers ends with a timeout failure at 15 s and leaves no timer behind", async () => {
    fetch.mockImplementation(never);
    const p = api("GET", "/api/v1/x").catch((e) => e);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // still waiting one ms before the deadline
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err).toBeInstanceOf(ApiFailure);
    expect([err.status, err.code, err.message]).toEqual([0, "timeout", TIMEOUT_MESSAGE]);
    expect(fetch).toHaveBeenCalledTimes(1); // a timeout is not retried: the spinner ends at the deadline
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a write gets 30 s, not 15", async () => {
    fetch.mockImplementation(never);
    const p = api("POST", "/api/v1/x", {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    let settled = false;
    p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(WRITE_DEADLINE_MS - READ_DEADLINE_MS);
    expect((await p).code).toBe("timeout");
  });

  it("a body that never finishes also ends at the deadline", async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, text: never });
    const p = api("GET", "/api/v1/x").catch((e) => e);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect((await p).code).toBe("timeout");
  });

  it("the deadline covers retries: a read that keeps failing slowly still ends by 15 s", async () => {
    fetch.mockImplementation(() => new Promise((_, rej) => setTimeout(() => rej(new TypeError("fetch failed")), 6000)));
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const p = api("GET", "/api/v1/x").catch((e) => e);
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    const err = await p;
    expect(err.code).toBe("timeout");
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("a caller abort is rethrown as the abort, not as a timeout", async () => {
    const ac = new AbortController();
    fetch.mockImplementation(never);
    const p = api("GET", "/api/v1/x", undefined, ac.signal).catch((e) => e);
    ac.abort();
    const err = await p;
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(ApiFailure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("api() retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(Math, "random").mockReturnValue(0); // smallest jitter: 200 ms, then 400 ms
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a POST is never retried: not on a network error, not on 502/503/504, not on a 429, not with an Idempotency-Key", async () => {
    for (const make of [() => Promise.reject(new TypeError("fetch failed")), () => Promise.resolve(reply(502)), () => Promise.resolve(reply(503)), () => Promise.resolve(reply(504)), () => Promise.resolve(reply(429, "", { "retry-after": "2" }))]) {
      for (const opts of [undefined, { idempotencyKey: KEY }]) {
        fetch.mockReset();
        fetch.mockImplementation(make);
        const p = api("POST", "/api/v1/x", {}, undefined, opts).catch((e) => e);
        await vi.advanceTimersByTimeAsync(WRITE_DEADLINE_MS);
        const err = await p;
        expect(err).toBeInstanceOf(ApiFailure);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("DELETE and PUT are not retried either", async () => {
    for (const m of ["DELETE", "PUT", "PATCH"]) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(503));
      await api(m, "/api/v1/x").catch(() => {});
      expect(fetch, m).toHaveBeenCalledTimes(1);
    }
  });

  it("a GET is retried on a network error, waiting the jittered backoff each time, then gives up after 2 retries", async () => {
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    const p = api("GET", "/api/v1/x").catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(backoffMs(0, () => 0) - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(backoffMs(1, () => 0));
    expect(fetch).toHaveBeenCalledTimes(3);
    const err = await p;
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect([err.status, err.code, err.message]).toEqual([0, "offline", OFFLINE_MESSAGE]);
  });

  it("jitter: the backoff varies with the random draw, between half and the full base, and doubles", () => {
    expect(backoffMs(0, () => 0)).toBe(200);
    expect(backoffMs(0, () => 0.999)).toBeGreaterThanOrEqual(399);
    expect(backoffMs(1, () => 0)).toBe(400);
    expect(backoffMs(1, () => 0.999)).toBeGreaterThanOrEqual(799);
  });

  it("a GET that fails once and then succeeds returns the data", async () => {
    fetch.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, '{"a":1}'));
    const p = api("GET", "/api/v1/x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ a: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("only a bare 502, 503 or 504 is retried; 500, 403, 404, 422 and a 503 with an application code are not", async () => {
    fetch.mockResolvedValue(reply(503, '{"error":{"code":"billing_not_configured"}}'));
    await api("GET", "/api/v1/x").catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const status of [500, 403, 404, 422]) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(status));
      await api("GET", "/api/v1/x").catch(() => {});
      expect(fetch, String(status)).toHaveBeenCalledTimes(1);
    }
    for (const status of [502, 503, 504]) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(status));
      const p = api("GET", "/api/v1/x").catch((e) => e);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(fetch, String(status)).toHaveBeenCalledTimes(3);
    }
  });

  it("no retry while the browser says it is offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    const err = await api("GET", "/api/v1/x").catch((e) => e);
    expect(err.code).toBe("offline");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("api() 429", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a 429 is never retried, for a read or a write: a refused call still counts against the session limit; retryAfter goes to the caller", async () => {
    for (const method of ["GET", "POST"]) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(429, '{"error":{"code":"rate_limited","message":"SECRET"}}', { "retry-after": "4" }));
      const p = api(method, "/api/v1/x", method === "GET" ? undefined : {}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(60000);
      const err = await p;
      expect([err.status, err.code, err.retryAfter], method).toEqual([429, "rate_limited", 4]);
      expect(fetch, method).toHaveBeenCalledTimes(1);
    }
  });

  it("a 503 that names a wait is not retried sooner than that wait", async () => {
    fetch.mockResolvedValueOnce(reply(503, "", { "retry-after": "5" })).mockResolvedValueOnce(reply(200, "{}"));
    const p = api("GET", "/api/v1/x");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await p;
  });

  it("a wait longer than the automatic limit is handed to the screen with retryAfter set, with no retry", async () => {
    fetch.mockResolvedValue(reply(429, '{"error":{"code":"rate_limited","message":"slow down"}}', { "retry-after": String(MAX_AUTO_WAIT_SECONDS + 20) }));
    const err = await api("GET", "/api/v1/x").catch((e) => e);
    expect([err.status, err.code, err.retryAfter]).toEqual([429, "rate_limited", MAX_AUTO_WAIT_SECONDS + 20]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a 429 with no usable Retry-After is not retried and carries 0", async () => {
    fetch.mockResolvedValue(reply(429));
    const err = await api("GET", "/api/v1/x").catch((e) => e);
    expect([err.status, err.retryAfter]).toEqual([429, 0]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a wait that would pass the deadline is not started (a gateway error naming a long wait)", async () => {
    fetch.mockResolvedValue(reply(503, "", { "retry-after": "10" }));
    const p = api("GET", "/api/v1/x").catch((e) => e);
    await vi.advanceTimersByTimeAsync(10000); // first retry after 10 s: 5 s left
    const err = await p; // the second wait (10 s) does not fit in 5 s, so it fails
    expect(err.kind).toBe("server_error");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborting a call during a retry wait leaves no timer behind", async () => {
    const ac = new AbortController();
    fetch.mockResolvedValue(reply(503, "", { "retry-after": "8" }));
    const p = api("GET", "/api/v1/x", undefined, ac.signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(100); // now waiting 8 s
    ac.abort();
    expect((await p).name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("api() server_error and what reaches the screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a 5xx is kind server_error with a fixed sentence; the server's code is kept, its words and details never surface", async () => {
    const body = JSON.stringify({ error: { code: "db_exploded", message: "relation accounts does not exist at /srv/app.js:12" }, details: [{ path: "x", message: "secret" }] });
    for (const status of [500, 501, 502, 503, 504, 599]) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(status, body));
      const p = api("POST", "/api/v1/x", {}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      const err = await p;
      expect([err.status, err.kind, err.code, err.message], String(status)).toEqual([status, "server_error", "db_exploded", SERVER_ERROR_MESSAGE]);
      expect(err.details).toBeUndefined();
      expect(err.message).not.toMatch(/accounts|srv|secret/);
    }
  });

  it("a 5xx with no JSON code has code server_error", async () => {
    fetch.mockResolvedValue(reply(500, "<html>oops</html>"));
    const err = await api("POST", "/api/v1/x", {}).catch((e) => e);
    expect([err.kind, err.code]).toEqual(["server_error", "server_error"]);
  });

  it("a structured refusal on a 503 keeps its code, is not retried, and a GET asks once (github_app_not_configured, preview_unavailable)", async () => {
    for (const code of ["github_app_not_configured", "preview_unavailable"]) {
      fetch.mockReset();
      fetch.mockResolvedValue(reply(503, JSON.stringify({ error: { code, message: "SERVICE TEXT" } })));
      const p = api("GET", "/api/v1/github/install-url").catch((e) => e);
      await vi.advanceTimersByTimeAsync(30000);
      const err = await p;
      expect([err.status, err.code, err.kind, err.message], code).toEqual([503, code, "server_error", SERVER_ERROR_MESSAGE]);
      expect(fetch, code).toHaveBeenCalledTimes(1);
    }
  });

  it("no failure kind puts null, undefined or NaN in its message", async () => {
    const cases = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.resolve(reply(500)),
      () => Promise.resolve(reply(503, "not json")),
      () => Promise.resolve(reply(429)),
      () => Promise.resolve(reply(404, '{"error":{"code":null,"message":null}}')),
      () => Promise.resolve(reply(422, '{"error":null}')),
      () => never(),
    ];
    for (const make of cases) {
      fetch.mockReset();
      fetch.mockImplementation(make);
      const p = api("POST", "/api/v1/x", {}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(WRITE_DEADLINE_MS);
      const err = await p;
      expect(err.message).toMatch(/\S/);
      expect(err.message).not.toMatch(/null|undefined|NaN/i);
      expect(String(err.code)).not.toMatch(/null|undefined|NaN/i);
    }
  });
});

describe("the offline bar", () => {
  function fakeDoc() {
    const handlers = new Map();
    const body = {
      kids: [],
      appendChild(el) {
        if (!this.kids.includes(el)) this.kids.push(el);
        el.parentNode = this;
      },
      removeChild(el) {
        this.kids = this.kids.filter((k) => k !== el);
        el.parentNode = null;
      },
    };
    return {
      body,
      visibilityState: "visible",
      createElement: () => ({ attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null }),
      addEventListener: (t, f) => handlers.set(t, f),
      removeEventListener: (t) => handlers.delete(t),
    };
  }
  function fakeWin() {
    const h = new Map();
    return {
      addEventListener: (t, f) => h.set(t, [...(h.get(t) || []), f]),
      removeEventListener: (t, f) => h.set(t, (h.get(t) || []).filter((x) => x !== f)),
      fire: (t) => (h.get(t) || []).forEach((f) => f({ type: t })),
    };
  }
  function tab(fetchImpl, over = {}) {
    const doc = fakeDoc();
    const win = fakeWin();
    const refresh = vi.fn();
    const live = createLive({ win, doc, fetch: fetchImpl, locks: undefined, BroadcastChannel: undefined, getNamespace: () => "ns", signOut: vi.fn(), ...over });
    live.onRefresh(refresh);
    const bars = () => doc.body.kids;
    return { live, doc, win, refresh, bars };
  }

  it("a request that cannot reach the server shows one bar, and a later answer removes it", async () => {
    let up = false;
    const t = tab(async () => {
      if (!up) throw new TypeError("fetch failed");
      return { status: 200, ok: true };
    });
    await expect(t.live.apiFetch("/api/v1/x", {})).rejects.toThrow();
    await expect(t.live.apiFetch("/api/v1/y", {})).rejects.toThrow();
    expect(t.bars()).toHaveLength(1); // one bar, not one per failure
    expect(t.bars()[0].textContent).toBe("You're offline, retrying when you're back");
    expect(t.bars()[0].attrs.role).toBe("status");
    up = true;
    await t.live.apiFetch("/api/v1/x", {});
    expect(t.bars()).toHaveLength(0);
    expect(t.live.offline()).toBe(false);
  });

  it("an abort (a deadline or a caller) does not show the bar", async () => {
    const t = tab(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(t.live.apiFetch("/api/v1/x", {})).rejects.toThrow();
    expect(t.bars()).toHaveLength(0);
  });

  it("going offline shows the bar; coming back removes it and refreshes the windows", () => {
    const t = tab(async () => ({ status: 200, ok: true }));
    t.live.start();
    t.win.fire("offline");
    expect(t.bars()).toHaveLength(1);
    t.win.fire("online");
    expect(t.bars()).toHaveLength(0);
    expect(t.refresh).toHaveBeenCalledTimes(1); // one online event, one refresh
    t.live.shutdown();
  });

  it("one online event is one refresh even right after another refresh (focus), and again after a long gap", () => {
    const t = tab(async () => ({ status: 200, ok: true }));
    t.live.start();
    t.win.fire("focus");
    expect(t.refresh).toHaveBeenCalledTimes(1);
    t.win.fire("offline");
    t.win.fire("online");
    expect(t.refresh).toHaveBeenCalledTimes(2);
    t.live.shutdown();
  });

  it("a tab that starts offline shows the bar at once", () => {
    const t = tab(async () => ({ status: 200, ok: true }), { onLine: () => false });
    t.live.start();
    expect(t.bars()).toHaveLength(1);
    t.live.shutdown();
    expect(t.bars()).toHaveLength(0); // shutting the client down never leaves a bar behind
  });

  it("the bar text never contains null or undefined", async () => {
    const t = tab(async () => {
      throw new TypeError("x");
    });
    await expect(t.live.apiFetch("/a", {})).rejects.toThrow();
    expect(t.bars()[0].textContent).not.toMatch(/null|undefined/);
  });
});
