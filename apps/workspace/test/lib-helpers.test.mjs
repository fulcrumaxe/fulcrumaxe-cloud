// apps/workspace/test/lib-helpers.test.mjs
//
// D#37 WS-F0b: the shared first-party app helpers in apps/_lib/. api() is
// tested against a stubbed fetch; confirmAction needs only a stub window, so
// the suite runs in vitest's default node environment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiFailure,
  DEFAULT_WAIT_SECONDS,
  OFFLINE_MESSAGE,
  api,
  createRetryGate,
  isRateLimited,
  parseRetryAfter,
  retryWords,
  waitSeconds,
} from "../apps/_lib/api.js";

const APPS = join(dirname(fileURLToPath(import.meta.url)), "..", "apps");

function reply(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

describe("api()", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("maps a network failure to ApiFailure(0, offline) with a fixed sentence", async () => {
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    const err = await api("POST", "/api/v1/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect([err.status, err.code]).toEqual([0, "offline"]);
    expect(err.message).toBe(OFFLINE_MESSAGE);
  });

  it("rethrows an abort untouched", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetch.mockRejectedValue(abort);
    await expect(api("GET", "/api/v1/x")).rejects.toBe(abort);
  });

  it("maps a non-JSON error body to http_<status> with a generic sentence", async () => {
    fetch.mockResolvedValue(reply(409, "<html>conflict</html>"));
    const err = await api("GET", "/api/v1/x").catch((e) => e);
    expect([err.status, err.code, err.message]).toEqual([409, "http_409", "Request failed (409)."]);
    expect(err.details).toBeUndefined();
  });

  it("maps the v1 error envelope, carrying details", async () => {
    const details = [{ path: "name", message: "too long" }];
    fetch.mockResolvedValue(
      reply(422, JSON.stringify({ error: { code: "validation_failed", message: "Bad name." }, details }))
    );
    const err = await api("POST", "/api/v1/x", { name: "n" }).catch((e) => e);
    expect([err.status, err.code, err.message]).toEqual([422, "validation_failed", "Bad name."]);
    expect(err.details).toEqual(details);
  });

  it("returns parsed JSON, or null for an empty body", async () => {
    fetch.mockResolvedValueOnce(reply(200, '{"a":1}')).mockResolvedValueOnce(reply(204, ""));
    expect(await api("GET", "/api/v1/x")).toEqual({ a: 1 });
    expect(await api("DELETE", "/api/v1/x")).toBeNull();
  });

  it("a 401 asks the server about the session exactly once and still throws the ApiFailure", async () => {
    fetch.mockImplementation(async (url) => (url === "/api/cloud/auth/me" ? reply(200, "{}") : reply(401, "")));
    const err = await api("GET", "/api/v1/x").catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    expect([err.status, err.code]).toEqual([401, "http_401"]);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/api/v1/x", "/api/cloud/auth/me"]);
  });

  it("sends Content-Type only on a mutation, with the body only when given", async () => {
    fetch.mockResolvedValue(reply(200, "{}"));
    await api("GET", "/a");
    await api("POST", "/b");
    await api("POST", "/c", { k: 1 });
    const [get, bare, withBody] = fetch.mock.calls.map((c) => c[1]);
    expect(get.headers).toEqual({ Accept: "application/json" });
    expect(bare.headers["Content-Type"]).toBe("application/json");
    expect(bare.body).toBeUndefined();
    expect(withBody.body).toBe('{"k":1}');
  });

  it("sends Idempotency-Key when the fifth argument gives a UUID, and no other request has one", async () => {
    fetch.mockResolvedValue(reply(202, "{}"));
    const key = "0f8fad5b-d9cb-469f-a165-70867728950e";
    await api("POST", "/api/v1/runs/x/retry", undefined, undefined, { idempotencyKey: key });
    await api("POST", "/api/v1/runs/x/cancel");
    const [withKey, without] = fetch.mock.calls.map((c) => c[1]);
    expect(withKey.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": key });
    expect(without.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("rejects a non-UUID key and any other option before fetch, sending nothing", async () => {
    fetch.mockResolvedValue(reply(202, "{}"));
    for (const opts of [{ idempotencyKey: "not-a-uuid" }, { idempotencyKey: "" }, { idempotencyKey: 7 }, { idempotencyKey: ["0f8fad5b-d9cb-469f-a165-70867728950e"] },{ headers: { "X-Evil": "1" } }, { idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e", "x-evil": "1" }]) {
      await expect(api("POST", "/api/v1/runs/x/retry", undefined, undefined, opts)).rejects.toThrow(TypeError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("429 handling", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const limited = (retryAfter) => ({
    ok: false,
    status: 429,
    headers: { get: (n) => (n.toLowerCase() === "retry-after" ? retryAfter : null) },
    text: async () => JSON.stringify({ error: { code: "rate_limited", message: "rate limit exceeded", request_id: "r" } }),
  });

  it("api() carries Retry-After on the ApiFailure as whole seconds", async () => {
    fetch.mockResolvedValue(limited("8"));
    const err = await api("POST", "/api/v1/model-connection/test").catch((e) => e);
    expect([err.status, err.code, err.retryAfter]).toEqual([429, "rate_limited", 8]);
    expect(isRateLimited(err)).toBe(true);
    expect(waitSeconds(err)).toBe(8);
  });

  it("a missing, empty, zero, negative, fractional or junk Retry-After is 0 on the failure and a fixed wait for the screen", async () => {
    for (const value of [null, "", "0", "-3", "1.5", "soon", "9999999999", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      fetch.mockResolvedValue(limited(value));
      const err = await api("POST", "/api/v1/x").catch((e) => e);
      expect(err.retryAfter, String(value)).toBe(0);
      expect(waitSeconds(err), String(value)).toBe(DEFAULT_WAIT_SECONDS);
    }
    expect(parseRetryAfter(undefined)).toBe(0);
  });

  it("a response with no headers object at all (a stub) still maps without throwing", async () => {
    fetch.mockResolvedValue({ ok: false, status: 429, text: async () => "" });
    const err = await api("POST", "/api/v1/x").catch((e) => e);
    expect([err.status, err.retryAfter]).toEqual([429, 0]);
  });

  it("retryWords says seconds up to two minutes, minutes after, and never prints undefined, NaN or null", () => {
    expect(retryWords(1)).toBe("Try again in 1 second.");
    expect(retryWords(8)).toBe("Try again in 8 seconds.");
    expect(retryWords(119)).toBe("Try again in 119 seconds.");
    expect(retryWords(120)).toBe("Try again in 2 minutes.");
    expect(retryWords(3600)).toBe("Try again in 60 minutes.");
    for (const bad of [undefined, null, NaN, 0, -4, Infinity, "5"]) {
      const text = retryWords(bad);
      expect(text, String(bad)).toMatch(/^Try again in \d+ seconds?\.$/);
      expect(text).not.toMatch(/undefined|null|NaN|Infinity/);
    }
  });

  it("createRetryGate counts down once a second, ends on 0, and a restart or cancel stops the old run", () => {
    vi.useFakeTimers();
    const seen = [];
    const gate = createRetryGate({ onChange: (n) => seen.push(n), now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout });
    gate.start(3);
    expect([gate.remaining, seen]).toEqual([3, [3]]);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([3, 2]);
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([3, 2, 1, 0]);
    expect(gate.remaining).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([3, 2, 1, 0]); // nothing after the end
    gate.start(2);
    gate.start(5); // a restart replaces the run in progress
    expect(gate.remaining).toBe(5);
    gate.cancel();
    expect(gate.remaining).toBe(0);
    const before = seen.length;
    vi.advanceTimersByTime(10_000);
    expect(seen.length).toBe(before);
    gate.start(NaN); // an unusable value waits the fixed time rather than 0
    expect(gate.remaining).toBe(DEFAULT_WAIT_SECONDS);
    gate.cancel();
    vi.useRealTimers();
  });
});

describe("dom.js", () => {
  it("confirmAction refuses without the themed dialog and only accepts true", async () => {
    const win = {};
    vi.stubGlobal("window", win);
    const { confirmAction } = await import("../apps/_lib/dom.js");
    expect(await confirmAction("Sure?")).toBe(false);
    win.fulcConfirm = async () => "yes";
    expect(await confirmAction("Sure?")).toBe(false);
    win.fulcConfirm = async () => true;
    expect(await confirmAction("Sure?")).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("single source", () => {
  it("only the two _lib files define the shared helpers, and no app re-exports them", () => {
    const def = /export (async )?function (h|api|timeNode|confirmAction)\b|export class ApiFailure/;
    const reexport = /export\s*\{[^}]*\}\s*from|export\s*\*\s*from/;
    const found = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|ts|tsx)$/.test(e.name)) {
          const src = readFileSync(p, "utf8");
          if (def.test(src)) found.push(relative(APPS, p));
          expect(reexport.test(src), p).toBe(false);
        }
      }
    };
    walk(APPS);
    expect(found.sort()).toEqual(["_lib/api.js", "_lib/dom.js"]);
  });
});
