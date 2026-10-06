import { describe, expect, it } from "vitest";
import { authorize, OPERATION_TABLE, type Operation } from "../src/operations.js";
import { hasScope, isHumanOnly, type Principal } from "../src/principals.js";

/**
 * Prototype pollution must not let a principal inherit the fields that
 * authorize / isHumanOnly / hasScope trust. A principal lacking an own
 * `kind`, `role` or `scopes` gets no access, whatever Object.prototype says.
 */
const OPERATIONS = Object.keys(OPERATION_TABLE) as Operation[];

function withPollution<T>(fields: Record<string, unknown>, fn: () => T): T {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const k of Object.keys(fields)) {
    saved.set(k, Object.getOwnPropertyDescriptor(Object.prototype, k));
    Object.defineProperty(Object.prototype, k, {
      value: fields[k],
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  try {
    return fn();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(Object.prototype, k, d);
      else delete (Object.prototype as Record<string, unknown>)[k];
    }
  }
}

const A = "11111111-1111-1111-1111-111111111111";
const U = "22222222-2222-2222-2222-222222222222";

describe("own-property reads under Object.prototype pollution", () => {
  it("a session principal without an own role is denied every operation", () => {
    withPollution({ role: "owner" }, () => {
      const p = { kind: "session", accountId: A, userId: U } as unknown as Principal;
      for (const op of OPERATIONS) expect(authorize(p, op), op).toBe("deny");
      expect(isHumanOnly(p)).toBe(false);
    });
  });

  it("a principal without an own kind is denied every operation", () => {
    for (const kind of ["session", "system", "token", "run"]) {
      withPollution({ kind, role: "owner", scopes: ["read", "write"] }, () => {
        const p = { accountId: A, userId: U } as unknown as Principal;
        for (const op of OPERATIONS) expect(authorize(p, op), `${kind}:${op}`).toBe("deny");
        expect(isHumanOnly(p)).toBe(false);
        expect(hasScope(p, "read")).toBe(false);
      });
    }
  });

  it("a token principal without own scopes is denied and has no scope", () => {
    withPollution({ scopes: ["read", "write"] }, () => {
      const p = { kind: "token", accountId: A, userId: U, tokenId: A } as unknown as Principal;
      for (const op of OPERATIONS) expect(authorize(p, op), op).toBe("deny");
      expect(hasScope(p, "read")).toBe(false);
      expect(hasScope(p, "write")).toBe(false);
    });
  });

  it("own fields still work while the prototype is polluted", () => {
    withPollution({ role: "member", kind: "run", scopes: [] }, () => {
      const s: Principal = { kind: "session", accountId: A, userId: U, role: "owner" };
      expect(authorize(s, "stage.set")).toBe("allow");
      expect(isHumanOnly(s)).toBe(true);
      const t: Principal = { kind: "token", accountId: A, userId: U, tokenId: A, scopes: ["read"] };
      expect(authorize(t, "read")).toBe("allow");
      expect(hasScope(t, "read")).toBe(true);
      expect(hasScope(t, "write")).toBe(false);
    });
  });

  it("restores the prototype", () => {
    expect(Object.hasOwn(Object.prototype, "role")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "kind")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "scopes")).toBe(false);
  });
});
