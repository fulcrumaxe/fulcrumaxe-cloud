// apps/workspace/test/onboarding-mode.test.mjs
//
// D#37 WS-F9a: the gate decision table (core/onboarding-mode.js) and the registry limit it relies on
// (core/app-registry.js restrictTo). The browser-level checks of the same branches are in e2e/onboarding.spec.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_APPS, enterOnboardingMode, isOpenStep, parseSteps, resolveAccess } from "../shell/core/onboarding-mode.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getOnboarding");
const fixture = (name) => JSON.parse(readFileSync(join(V1, name), "utf8"));
const reply = (status, body) => vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }));

describe("resolveAccess: which screen a signed-in session gets", () => {
  it("open: the desktop, and no onboarding read is made", async () => {
    const doFetch = reply(200, fixture("200-new.json"));
    expect(await resolveAccess({ workspace_access: "open" }, doFetch)).toBe("desktop");
    expect(doFetch).not.toHaveBeenCalled();
  });

  for (const access of ["subscription_ended", undefined, "", "past_due", "OPEN"]) {
    it(`${JSON.stringify(access)}: today's gate whatever onboarding says, and no read is made`, async () => {
      const doFetch = reply(200, fixture("200-new.json"));
      expect(await resolveAccess({ workspace_access: access }, doFetch)).toBe("gate");
      expect(doFetch).not.toHaveBeenCalled();
    });
  }

  for (const name of ["200-new.json", "200-step3.json", "200-pay.json", "200-skipped.json"]) {
    it(`no_subscription + ${name}: onboarding mode after exactly one read`, async () => {
      const doFetch = reply(200, fixture(name));
      expect(await resolveAccess({ workspace_access: "no_subscription" }, doFetch)).toBe("onboarding");
      expect(doFetch).toHaveBeenCalledTimes(1);
      expect(doFetch.mock.calls[0][0]).toBe("/api/v1/onboarding");
    });
  }

  // Steps 1 and 2 follow the current state on the server, so a finished account can have one of them open again.
  for (const reverted of ["model_key", "readonly_app"]) {
    it(`no_subscription + every other step done but ${reverted} open again: onboarding mode, not the gate`, async () => {
      const done = fixture("200-complete.json");
      const body = { ...done, steps: done.steps.map((s) => (s.step === reverted ? { ...s, completed_at: null } : s)) };
      const doFetch = reply(200, body);
      expect(await resolveAccess({ workspace_access: "no_subscription" }, doFetch)).toBe("onboarding");
      expect(doFetch).toHaveBeenCalledTimes(1);
    });
  }

  // Paid without a preview: the skipped preview does not hold the account in onboarding mode on its own.
  it("no_subscription + everything done or skipped: the gate, not onboarding mode", async () => {
    const done = fixture("200-complete.json");
    const body = { ...done, steps: done.steps.map((s) => (s.step === "preview" ? { ...s, completed_at: null, skipped: true } : s)) };
    expect(await resolveAccess({ workspace_access: "no_subscription" }, reply(200, body))).toBe("gate");
  });

  it("no_subscription + all six steps done: onboarding complete + unpaid still gets the gate", async () => {
    expect(await resolveAccess({ workspace_access: "no_subscription" }, reply(200, fixture("200-complete.json")))).toBe("gate");
  });

  for (const status of [401, 403, 404, 500, 503]) {
    it(`no_subscription + a ${status} answer fails closed to the gate`, async () => {
      expect(await resolveAccess({ workspace_access: "no_subscription" }, reply(status, fixture("200-new.json")))).toBe("gate");
    });
  }

  it("no_subscription + a network failure, an unreadable body or an invalid body fail closed to the gate", async () => {
    const s = { workspace_access: "no_subscription" };
    expect(await resolveAccess(s, vi.fn(() => Promise.reject(new TypeError("offline"))))).toBe("gate");
    expect(await resolveAccess(s, vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("x")) })))).toBe("gate");
    const bad = fixture("200-new.json");
    for (const body of [null, "x", {}, { steps: [] }, { ...bad, steps: bad.steps.slice(1) }, { ...bad, steps: [...bad.steps].reverse() },
      { ...bad, steps: bad.steps.map((x, i) => (i ? x : { ...x, completed_at: "not a time" })) },
      { ...bad, steps: bad.steps.map((x, i) => (i ? x : { ...x, completed_at: undefined })) }]) {
      expect(await resolveAccess(s, reply(200, body))).toBe("gate");
    }
  });

  describe("a read that never answers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it("is given up on after five seconds and gives the gate", async () => {
      const hang = vi.fn((_url, init) => new Promise((_ok, fail) => init.signal.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")))));
      const result = resolveAccess({ workspace_access: "no_subscription" }, hang);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe("gate");
    });
  });
});

describe("parseSteps", () => {
  it("returns the six steps in the server's order and drops unknown fields", () => {
    const steps = parseSteps({ ...fixture("200-step3.json"), extra: 1 });
    expect(steps.map((s) => s.step)).toEqual(["model_key", "readonly_app", "preview", "pay", "write_app", "first_pr"]);
    expect(steps.findIndex((s) => s.completed_at === null)).toBe(2);
  });

  it("reads skipped: false when the body has none, and keeps true for the preview with no time", () => {
    expect(parseSteps(fixture("200-new.json")).every((s) => s.skipped === false)).toBe(true);
    const old = fixture("200-new.json");
    expect(parseSteps({ ...old, steps: old.steps.map((s) => ({ step: s.step, completed_at: s.completed_at })) }).every((s) => s.skipped === false)).toBe(true);
    const steps = parseSteps(fixture("200-skipped.json"));
    expect(steps.filter((s) => s.skipped).map((s) => s.step)).toEqual(["preview"]);
    expect(steps.find((s) => s.step === "preview").completed_at).toBeNull();
  });

  it("refuses a skipped step that also has a time, and a skipped that is not a boolean", () => {
    const body = fixture("200-skipped.json");
    for (const bad of [{ ...body, steps: body.steps.map((x) => (x.step === "pay" ? { ...x, skipped: true } : x)) },
      { ...body, steps: body.steps.map((x) => (x.step === "preview" ? { ...x, skipped: "yes" } : x)) },
      { ...body, steps: body.steps.map((x) => (x.step === "preview" ? { ...x, skipped: null } : x)) }]) {
      expect(parseSteps(bad)).toBeNull();
    }
  });

  it("a skipped step is not open", () => {
    const steps = parseSteps(fixture("200-skipped.json"));
    expect(steps.filter(isOpenStep).map((s) => s.step)).toEqual(["model_key", "readonly_app", "write_app", "first_pr"]);
  });
});

describe("the registry limit (app-registry.js restrictTo)", () => {
  async function registry() {
    vi.resetModules();
    global.window = {};
    await import("../shell/core/app-registry.js");
    const apps = window.FULCApps;
    for (const id of ["onboarding", "model-key", "repos", "pipeline", "runs", "themes", "developer"]) apps.register(id, { title: id });
    return { apps, window };
  }
  afterEach(() => delete global.window);

  it("unpaid sees an app outside the four: with no limit every registered app is listed and opens", async () => {
    const { apps } = await registry();
    expect(apps.ids()).toHaveLength(7);
    expect(apps.get("pipeline")).not.toBeNull();
  });

  it("limits get, all, ids, isRegistered, visible and launchable to the four apps", async () => {
    const { apps, window } = await registry();
    expect(enterOnboardingMode()).toBe(true);
    const four = [...ONBOARDING_APPS].sort();
    expect(four).toEqual(["model-key", "onboarding", "repos", "themes"]);
    expect(apps.ids().sort()).toEqual(four);
    expect(apps.all().map((a) => a.id).sort()).toEqual(four);
    expect(apps.visible().map((a) => a.id).sort()).toEqual(four);
    expect(apps.launchable().map((a) => a.id).sort()).toEqual(four);
    for (const id of ["pipeline", "runs", "developer", "nope"]) {
      expect(apps.get(id)).toBeNull();
      expect(apps.isRegistered(id)).toBe(false);
    }
    expect(apps.get("repos").id).toBe("repos");
    // Still limited when entitlements answer Allow for everything.
    window.FULCEntitlements = { _ready: true, decision: () => ({ type: "Allow" }) };
    expect(apps.visible()).toHaveLength(4);
    expect(apps.launchable()).toHaveLength(4);
  });

  it("only narrows: a later restrictTo cannot bring an app back, and a bad argument changes nothing", async () => {
    const { apps } = await registry();
    apps.restrictTo(ONBOARDING_APPS);
    apps.restrictTo(["pipeline", "repos"]);
    expect(apps.ids()).toEqual(["repos"]);
    apps.restrictTo("pipeline");
    apps.restrictTo(null);
    expect(apps.ids()).toEqual(["repos"]);
  });

  it("enterOnboardingMode reports failure when the registry cannot limit", () => {
    global.window = { FULCApps: {} };
    expect(enterOnboardingMode()).toBe(false);
  });
});
