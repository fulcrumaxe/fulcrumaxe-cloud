// apps/workspace/test/vm-token-copy.test.mjs
//
// B-6-VMTOKEN VMTOKEN-4: a machine in virtual machine mode (engine microvm) is given a Claude token, not a sign-in. The words live in onboarding-engine.js and runners-fleet.js; they are
// shown by Onboarding (the claude step) and Machines (a row). The drawn screens are in e2e/onboarding.spec.ts and e2e/runners.spec.ts.

import { describe, expect, it } from "vitest";
import * as engine from "../apps/onboarding/onboarding-engine.js";
import { describeStep } from "../apps/onboarding/onboarding-engine.js";
import * as fleet from "../apps/runners/runners-fleet.js";
import { needsVmToken, readMachine, VM_TOKEN_COMMAND, VM_TOKEN_LINE, VM_TOKEN_STAYS } from "../apps/runners/runners-fleet.js";

const IDS = ["machine", "claude", "github_app", "project", "plan", "install", "live"];
const T = "2026-11-20T10:00:00.000Z";
const track = (states, tier) =>
  IDS.map((id) => {
    const state = states[id] || "pending";
    return { step: id, state, completed_at: state === "done" ? T : null, tier: id === "machine" ? tier : null, failure: null };
  });
const at = (steps, id, ctx = {}) => describeStep(steps, IDS.indexOf(id), { name: "box-1", origin: "https://cloud.example.test", ...ctx });
const WORDS = "Virtual machine mode needs a Claude token on this machine. On that machine run fx-runner credentials set-vm-token.";

describe("the words", () => {
  it("Onboarding and Machines say exactly the same thing", () => {
    for (const k of ["VM_TOKEN_COMMAND", "VM_TOKEN_LINE", "VM_TOKEN_STAYS"]) expect(engine[k]).toBe(fleet[k]);
  });
  it("are fixed text with the command in them", () => {
    expect(VM_TOKEN_LINE).toBe(WORDS);
    expect(VM_TOKEN_STAYS).toBe("The token stays on that machine and is never sent to us.");
    expect(VM_TOKEN_COMMAND).toBe("fx-runner credentials set-vm-token");
  });
  it("needsVmToken: only a microvm machine without a token; an unknown or standard engine keeps the old copy", () => {
    expect(needsVmToken("microvm", false)).toBe(true);
    expect(needsVmToken("microvm", undefined)).toBe(true);
    expect(needsVmToken("microvm", true)).toBe(false);
    expect(needsVmToken("standard", false)).toBe(false);
    expect(needsVmToken(null, false)).toBe(false);
    expect(needsVmToken(undefined, false)).toBe(false);
  });
});

describe("Onboarding: the claude step on a microVM machine", () => {
  it("says what to run, that the token stays there, and shows a command to copy; no sign-in wording", () => {
    const v = at(track({ machine: "done", claude: "active" }, "microvm"), "claude");
    expect(v.lines).toEqual([WORDS, VM_TOKEN_STAYS]);
    expect(v.commands).toEqual([{ label: "", text: VM_TOKEN_COMMAND }]);
    expect(v.label).toBe("Give the machine a Claude token");
    expect(JSON.stringify(v)).not.toMatch(/sign in|signed in|undefined|null/i);
  });
  it("a later step names the token step, not the sign-in", () => {
    expect(at(track({ machine: "done", claude: "active" }, "microvm"), "plan").lines).toEqual(["Finish Give the machine a Claude token first"]);
  });
  it("with a token present nothing new shows, and the done line says token", () => {
    const v = at(track({ machine: "done", claude: "done" }, "microvm"), "claude");
    expect(v.lines).toEqual(["A Claude token is set on box-1"]);
    expect(v.commands).toEqual([]);
  });
  it("a standard machine and one with no reported engine keep the old sign-in copy", () => {
    for (const tier of ["standard", null]) {
      const v = at(track({ machine: "done", claude: "active" }, tier), "claude");
      expect(v.label).toBe("Sign in to Claude on the machine");
      expect(v.commands).toEqual([{ label: "", text: "claude" }]);
      expect(v.lines.join(" ")).not.toMatch(/token/i);
    }
  });
  it("an offline microvm machine says it is offline, not the token notice", () => {
    const v = at(track({ machine: "done", claude: "active" }, "microvm"), "claude", { offline: true, last_seen_min: 4 });
    expect(v.lines).toEqual(["box-1 was last seen 4 min ago"]);
  });
});

describe("Machines: the row's facts the notice reads", () => {
  const row = (extra) => readMachine({ id: "m1", name: "box-1", live: true, running: null, ...extra });
  it("a microvm machine with no token needs the notice; with a token it does not", () => {
    const none = row({ tier: "microvm", claude: false });
    const have = row({ tier: "microvm", claude: true });
    expect(needsVmToken(none.tier, none.claude)).toBe(true);
    expect(needsVmToken(have.tier, have.claude)).toBe(false);
  });
  it("a standard machine, and a machine whose engine is not reported, never get it", () => {
    for (const tier of ["standard", undefined, "bogus"]) {
      const m = row({ tier, claude: false });
      expect(needsVmToken(m.tier, m.claude)).toBe(false);
    }
  });
});
