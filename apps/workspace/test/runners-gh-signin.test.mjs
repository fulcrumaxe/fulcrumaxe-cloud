// apps/workspace/test/runners-gh-signin.test.mjs
//
// D#845 ON-19c2: the GitHub sign-in on a managed server's card, against a fake call(): the capability read, every state (idle, starting, waiting with the address and code, done, each closed
// failure word, cancel, sign-out) and the exact shapes the address and code must have. The DOM is in e2e/runners.spec.ts.
import { describe, expect, it } from "vitest";
import { GH_DEVICE_URL_PATTERN, GH_LOGIN_FAILURE_CODES, GH_USER_CODE_PATTERN } from "../../../packages/runner-protocol/src/machineCommands.ts";
import { GH_DEVICE_URL, GH_FAILURE_WORDS, GH_USER_CODE, createGhSignIn, readGhLogin, readServers } from "../apps/runners/runners-fleet.js";

const RUNNER = "3c9a1f52-6d84-4e07-b2a1-8f5d0c7e9a13";
const URL_OK = "https://github.com/login/device";
const req = (status, extra = {}) => ({ request: { request_id: "r", status, expires_at: "2099-01-01T00:00:00.000Z", device_url: null, user_code: null, failure_code: null, ...extra } });
const harness = (reply) => {
  const calls = [];
  const timers = [];
  return { calls, timers, call: async (m, u, b) => (calls.push([m, u, b]), reply(m, u)), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => timers.splice(0) };
};

describe("the capability read", () => {
  it("is true only when the cloud says gh_login is true", () => {
    const base = { id: "a", name: "s", kind: "hetzner_cloud", status: "ready", runner_id: RUNNER, status_at: "2026-11-24T10:00:00.000Z" };
    expect(readServers({ servers: [{ ...base, gh_login: true }] })[0].ghLogin).toBe(true);
    for (const v of [false, null, undefined, "true"]) expect(readServers({ servers: [{ ...base, gh_login: v }] })[0].ghLogin).toBe(false);
  });
});

describe("the shapes shown", () => {
  it("are the protocol's own patterns", () => {
    expect(GH_DEVICE_URL.source).toBe(GH_DEVICE_URL_PATTERN.source);
    expect(GH_USER_CODE.source).toBe(GH_USER_CODE_PATTERN.source);
  });
  it("shows the address and code only when both match, and nothing else the cloud sent", () => {
    expect(readGhLogin(req("awaiting_code", { device_url: URL_OK, user_code: "AB12-CD34" }), "")).toMatchObject({ status: "awaiting_code", url: URL_OK, code: "AB12-CD34" });
    for (const [url, code] of [["http://github.com/login/device", "AB12-CD34"], ["https://evil.example/login/device", "AB12-CD34"], [URL_OK + "?x=1", "AB12-CD34"], [URL_OK, "ab12-cd34"], [URL_OK, "AB12CD34"], [URL_OK, null]]) {
      expect(readGhLogin(req("awaiting_code", { device_url: url, user_code: code }), "")).toMatchObject({ status: "awaiting_code", url: "", code: "" });
    }
  });
});

describe("every state of the request", () => {
  it("has plain words for every closed failure code, with the ratified sentence for an account already signed in", () => {
    expect(GH_FAILURE_WORDS.already_signed_in).toBe("This machine is already signed in to GitHub. Sign out first, then try again.");
    for (const code of GH_LOGIN_FAILURE_CODES) {
      expect(typeof GH_FAILURE_WORDS[code], code).toBe("string");
      expect(readGhLogin(req("failed", { failure_code: code }), "").words, code).toBe(GH_FAILURE_WORDS[code]);
    }
    expect(readGhLogin(req("failed", { failure_code: "server wrote this" }), "").words).toBe("The GitHub sign-in didn't finish. Start again.");
    expect(readGhLogin(req("awaiting_code", { failure_code: "invalid_relay" }), "").words).toBe(GH_FAILURE_WORDS.invalid_relay);
    expect(readGhLogin(req("expired"), "").words).toBe(GH_FAILURE_WORDS.timeout);
  });
  it("reads none, pending, done (only when watched) and history as the panel needs", () => {
    expect(readGhLogin({ request: null }, "").status).toBe("idle");
    expect(readGhLogin(req("pending"), "").status).toBe("pending");
    expect(readGhLogin(req("done"), "").status).toBe("idle");
    expect(readGhLogin(req("done"), "", true).status).toBe("done");
    expect(readGhLogin(req("failed", { failure_code: "busy", expires_at: "2026-01-01T00:00:00.000Z" }), "2026-06-01T00:00:00.000Z").status).toBe("idle");
    expect(readGhLogin(req("surprise"), "").status).toBe("idle");
  });
});

describe("the sign-in keyed by the runner id", () => {
  it("starts, follows the request to the address and code, then to done, and is read again only while live", async () => {
    let state = req("pending");
    const t = harness((m) => (m === "GET" ? state : {}));
    const s = createGhSignIn({ call: t.call, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await s.start(RUNNER);
    expect(t.calls).toEqual([["POST", "/api/runners/" + RUNNER + "/gh-login", undefined], ["GET", "/api/runners/" + RUNNER + "/gh-login", undefined]]);
    expect(t.timers).toHaveLength(1);
    state = req("awaiting_code", { device_url: URL_OK, user_code: "AB12-CD34" });
    await t.timers[0]();
    expect(s.get(RUNNER)).toMatchObject({ status: "awaiting_code", url: URL_OK, code: "AB12-CD34" });
    state = req("done");
    await t.timers[1]();
    expect(s.get(RUNNER).status).toBe("done");
    expect(t.timers).toHaveLength(2); // done is not live: no third read
    s.stop();
  });
  it("cancels with its own route and then reads the result", async () => {
    let state = req("awaiting_code", { device_url: URL_OK, user_code: "AB12-CD34" });
    const t = harness((m) => (m === "GET" ? state : {}));
    const s = createGhSignIn({ call: t.call, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await s.load(RUNNER);
    state = req("failed", { failure_code: "cancelled" });
    await s.cancel(RUNNER);
    expect(t.calls[1]).toEqual(["POST", "/api/runners/" + RUNNER + "/gh-login/cancel", undefined]);
    expect(s.get(RUNNER)).toMatchObject({ status: "failed", words: "Sign-in cancelled.", code: "" });
    s.stop();
  });
  it("signs out on its own route, and shows a refusal as a fixed sentence, never the server's words", async () => {
    const t = harness(() => ({}));
    const s = createGhSignIn({ call: t.call, setTimer: t.setTimer, clearTimer: t.clearTimer });
    expect(await s.logout(RUNNER)).toBe(true);
    expect(t.calls).toEqual([["POST", "/api/runners/" + RUNNER + "/gh-logout", undefined]]);
    const bad = (code, status) => harness(() => { throw Object.assign(new Error("server text that must never be shown"), { status, code }); });
    for (const [code, status, words] of [["not_supported", 409, GH_FAILURE_WORDS.unsupported_platform], ["not_managed_server", 409, GH_FAILURE_WORDS.unsupported_platform], ["x", 403, "Only owners and admins can do this."]]) {
      const b = bad(code, status);
      const r = createGhSignIn({ call: b.call, setTimer: b.setTimer, clearTimer: b.clearTimer });
      expect(await r.start(RUNNER)).toBeUndefined();
      expect(r.get(RUNNER).error).toBe(words);
      expect(r.get(RUNNER).busy).toBe(false);
    }
  });
});
