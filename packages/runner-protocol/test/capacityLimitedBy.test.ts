import { describe, expect, it } from "vitest";
import { ClaimCapacity, ClaimMessage, LIMITED_BY } from "../src/messages.js";

describe("the optional limited_by of a claim's capacity (D#6 C43-2b)", () => {
  const base = { light: { limit: 3, in_use: 0 }, heavy: { limit: 1, in_use: 0 } };
  it("is a closed set, and a capacity without it, or with null, is still valid", () => {
    expect([...LIMITED_BY]).toEqual(["memory", "cpu", "disk", "paused", "ceiling", "usage_limit"]);
    expect(ClaimCapacity.safeParse(base).success).toBe(true);
    expect(ClaimCapacity.safeParse({ ...base, limited_by: null }).success).toBe(true);
    for (const cause of LIMITED_BY) expect(ClaimCapacity.safeParse({ ...base, limited_by: cause }).success, cause).toBe(true);
  });
  it("refuses a value outside the set, any other type, and any other extra key (the object stays strict)", () => {
    for (const bad of ["gpu", "Memory", "", 1, true, {}]) expect(ClaimCapacity.safeParse({ ...base, limited_by: bad }).success, JSON.stringify(bad)).toBe(false);
    expect(ClaimCapacity.safeParse({ ...base, reason: "memory" }).success).toBe(false);
    expect(ClaimMessage.safeParse({ capacity: { ...base, limited_by: "cpu" } }).success).toBe(true);
    expect(ClaimMessage.safeParse({ capacity: { ...base, limited_by: "cpu" }, extra: 1 }).success).toBe(false);
  });
});
