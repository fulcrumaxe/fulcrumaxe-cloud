import { describe, expect, it } from "vitest";
import { ClaimMessage, CURRENT_PROTOCOL_VERSION, VERIFY_SIGN_IN_MIN_PROTOCOL, VERIFY_SIGN_IN_STATES } from "../src/messages.js";

/** D#749 VERIFY-SIGNIN-EXPIRY: protocol 18 and the one optional word on a claim. */
describe("the verify sign-in on a claim", () => {
  it("is protocol 18, and the current version is 27; the claim stays strict, so an older cloud's parse would refuse the key (the cloud deploys first)", () => {
    expect(VERIFY_SIGN_IN_MIN_PROTOCOL).toBe(18);
    expect(CURRENT_PROTOCOL_VERSION).toBe(27);
    const before = ClaimMessage.omit({ verify_sign_in: true });
    expect(before.safeParse({ verify_sign_in: "ok" }).success).toBe(false);
    expect(before.safeParse({}).success).toBe(true);
  });

  it("takes exactly the four words, alone or with a capacity, and nothing else", () => {
    expect([...VERIFY_SIGN_IN_STATES]).toEqual(["ok", "expiring_soon", "expired", "missing"]);
    for (const state of VERIFY_SIGN_IN_STATES) expect(ClaimMessage.safeParse({ verify_sign_in: state }).success, state).toBe(true);
    for (const bad of ["", "OK", "fine", "expired ", 1, null, true, ["ok"], { state: "ok" }]) expect(ClaimMessage.safeParse({ verify_sign_in: bad }).success, JSON.stringify(bad)).toBe(false);
    expect(ClaimMessage.safeParse({ verify_sign_in: "ok", cookie: "x" }).success).toBe(false);
    expect(ClaimMessage.safeParse({}).success).toBe(true);
  });
});
