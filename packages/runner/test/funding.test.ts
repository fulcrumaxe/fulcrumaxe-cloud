import { describe, expect, it } from "vitest";
import { UnsupportedFundingError, defaultResolvePayer } from "../src/funding.js";

describe("defaultResolvePayer (D#2 H09b2, correction C16)", () => {
  it("returns the run's own account when funding is omitted", () => {
    expect(defaultResolvePayer({ accountId: "acct-1" })).toBe("acct-1");
  });

  it("returns the run's own account for {kind:'self'}", () => {
    expect(defaultResolvePayer({ accountId: "acct-1", funding: { kind: "self" } })).toBe("acct-1");
  });

  it("throws UnsupportedFundingError for {kind:'claim'} -- D#70 BRD-4 is not built here", () => {
    expect(() =>
      defaultResolvePayer({
        accountId: "acct-1",
        funding: { kind: "claim", payerAccountId: "acct-2", fundingId: "f1" },
      }),
    ).toThrow(UnsupportedFundingError);
  });
});
