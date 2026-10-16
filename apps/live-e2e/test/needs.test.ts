import { describe, expect, it } from "vitest";
import { BYPASS_ENV, firstNeedProblem, firstUnmetNeed, isNeedMet, SCRIPTED_SIGNIN_ROLES, STRIPE_RESTRICTED_KEY_ENV } from "../src/needs.js";
import { GOOD_HOST, makePack, makeTarget, needsCtx } from "./helpers.js";

describe("needs: bypass", () => {
  it("is unmet on a protected target without the secret, met with it", () => {
    const t = makeTarget({ protected: true });
    expect(isNeedMet("bypass", t, needsCtx({}))).toBe(false);
    expect(isNeedMet("bypass", t, needsCtx({ [BYPASS_ENV]: "" }))).toBe(false);
    expect(isNeedMet("bypass", t, needsCtx({ [BYPASS_ENV]: "s3cret" }))).toBe(true);
  });

  it("is trivially met when the target declares no protection", () => {
    expect(isNeedMet("bypass", makeTarget({ protected: false }), needsCtx({}))).toBe(true);
  });
});

describe("needs: stripe-test", () => {
  const t = makeTarget();
  it("is unmet when the value is absent or empty", () => {
    expect(isNeedMet("stripe-test", t, needsCtx({}))).toBe(false);
    expect(isNeedMet("stripe-test", t, needsCtx({ [STRIPE_RESTRICTED_KEY_ENV]: "" }))).toBe(false);
  });
  it("is met only by a restricted test-mode key", () => {
    expect(isNeedMet("stripe-test", t, needsCtx({ [STRIPE_RESTRICTED_KEY_ENV]: "rk_test_abc123" }))).toBe(true);
  });
  it("is never met by a live key, a secret key, or a bare prefix", () => {
    for (const v of ["rk_live_abc123", "sk_live_abc123", "sk_test_abc123", "rk_test_", "xrk_test_abc"]) {
      expect(isNeedMet("stripe-test", t, needsCtx({ [STRIPE_RESTRICTED_KEY_ENV]: v })), v).toBe(false);
    }
  });
});

describe("needs: host-capacity", () => {
  const t = makeTarget();
  const gib = 1024 ** 3;
  it("is met below the load ceiling with enough free memory", () => {
    expect(isNeedMet("host-capacity", t, needsCtx({}, GOOD_HOST))).toBe(true);
    expect(isNeedMet("host-capacity", t, needsCtx({}, { loadavg1: () => 17.99, memAvailableBytes: () => 4 * gib }))).toBe(true);
  });
  it("is unmet at load 18, below 4 GiB, or when either reading is unavailable", () => {
    expect(isNeedMet("host-capacity", t, needsCtx({}, { loadavg1: () => 18, memAvailableBytes: () => 16 * gib }))).toBe(false);
    expect(isNeedMet("host-capacity", t, needsCtx({}, { loadavg1: () => 1, memAvailableBytes: () => 4 * gib - 1 }))).toBe(false);
    expect(isNeedMet("host-capacity", t, needsCtx({}, { loadavg1: () => null, memAvailableBytes: () => 16 * gib }))).toBe(false);
    expect(isNeedMet("host-capacity", t, needsCtx({}, { loadavg1: () => 1, memAvailableBytes: () => null }))).toBe(false);
  });
});

describe("needs: not yet evaluable", () => {
  it("treats a known network need as unmet rather than guessing (T3 and T9 evaluate those)", () => {
    for (const n of ["session:owner", "model-key", "caps-set", "webhook-sink", "signin:scripted"]) {
      expect(isNeedMet(n, makeTarget(), needsCtx({ [BYPASS_ENV]: "x" })), n).toBe(false);
    }
  });
});

describe("needs: first unmet, in declared order", () => {
  it("reports the first unmet need", () => {
    const pack = makePack({ id: "p", needs: ["bypass", "stripe-test"] });
    expect(firstUnmetNeed(pack, makeTarget(), needsCtx({}))).toBe("bypass");
    expect(firstUnmetNeed(pack, makeTarget(), needsCtx({ [BYPASS_ENV]: "x" }))).toBe("stripe-test");
    expect(firstUnmetNeed(pack, makeTarget(), needsCtx({ [BYPASS_ENV]: "x", [STRIPE_RESTRICTED_KEY_ENV]: "rk_test_1" }))).toBeNull();
  });
});

describe("needs: checked session and test-repo first, then model-key, then caps-set (R-441-T3-21)", () => {
  it("names the earlier need whatever order the pack declares them in", () => {
    const t = makeTarget();
    const ctx = { ...needsCtx({ [BYPASS_ENV]: "x" }), network: {} as never };
    const pack = makePack({ id: "p", needs: ["caps-set", "sandbox", "model-key", "session:owner"] });
    expect(firstUnmetNeed(pack, t, ctx)).toBe("session:owner");
    const sessionOnly = { ...ctx, network: { "session:owner": { met: true } } as never };
    expect(firstUnmetNeed(pack, t, sessionOnly)).toBe("model-key");
    const keyToo = { ...ctx, network: { "session:owner": { met: true }, "model-key": { met: true } } as never };
    expect(firstUnmetNeed(pack, t, keyToo)).toBe("caps-set");
  });
});

describe("needs: network results", () => {
  const t = makeTarget();
  const withNetwork = (network: Record<string, { met: boolean; refuse?: string }>) => ({ ...needsCtx({ [BYPASS_ENV]: "x" }), network: network as never });

  it("a probed need is met only when its result says so; a need without a result stays unmet", () => {
    expect(isNeedMet("session:owner", t, withNetwork({ "session:owner": { met: true } }))).toBe(true);
    expect(isNeedMet("session:owner", t, withNetwork({ "session:owner": { met: false } }))).toBe(false);
    expect(isNeedMet("model-key", t, withNetwork({ "session:owner": { met: true } }))).toBe(false);
  });

  it("an unmet need that asked to refuse is reported with its reason; the others are plain skips", () => {
    const pack = makePack({ id: "p", needs: ["session:owner", "caps-set"] });
    const ctx = withNetwork({ "session:owner": { met: true }, "caps-set": { met: false, refuse: "caps" } });
    expect(firstNeedProblem(pack, t, ctx)).toEqual({ need: "caps-set", refuse: "caps" });
    expect(firstNeedProblem(pack, t, withNetwork({ "session:owner": { met: false } }))).toEqual({ need: "session:owner" });
    expect(firstNeedProblem(pack, t, withNetwork({ "session:owner": { met: true }, "caps-set": { met: true } }))).toBeNull();
  });

  it("signin:scripted is never met while option B is what is built, whatever the environment says", () => {
    expect(SCRIPTED_SIGNIN_ROLES).toEqual([]);
    for (const env of [{}, { LIVE_E2E_SIGNIN_SCRIPTED: "true" }, { [BYPASS_ENV]: "x" }]) expect(isNeedMet("signin:scripted", t, needsCtx(env))).toBe(false);
    // Not even a probe result can make it met: only the role list above does.
    expect(isNeedMet("signin:scripted", t, withNetwork({ "signin:scripted": { met: true } }))).toBe(false);
  });
});
