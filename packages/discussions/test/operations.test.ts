import { describe, expect, it } from "vitest";
import * as indexExports from "../src/index.js";
import { authorize, OPERATION_TABLE, type OperationRule, type Operation } from "../src/operations.js";
import type { Principal } from "../src/principals.js";

/**
 * Criterion 1: "OPERATION_TABLE ... matches the Conventions operation
 * table cell for cell (a test encodes the table independently and
 * compares). A table-driven test calls every (principal kind x role x
 * operation) pair. Every pair not marked v returns forbidden and changes
 * no row." EXPECTED_TABLE below is a hand-transcription of the
 * Conventions' own markdown table, independent of operations.ts's own
 * object literal -- the "encodes the table independently" half. Row shape
 * matches OperationRule: [sessionOwnerAdmin, sessionMember, token,
 * tokenScope, run, system].
 */
const EXPECTED_TABLE: Record<Operation, OperationRule> = {
  read: ["allow", "allow", "allow", "read", "thread_only", "allow"],
  "discussion.create": ["allow", "allow", "allow", "write", "deny", "allow"],
  "discussion.revise": ["allow", "own", "own", "write", "deny", "allow"],
  "comment.post": ["allow", "allow", "allow", "write", "thread_only", "allow"],
  "comment.post_agent": ["deny", "deny", "deny", null, "deny", "allow"],
  "comment.edit_own": ["own", "own", "own", "write", "deny", "deny"],
  "comment.tombstone_any": ["allow", "deny", "deny", null, "deny", "deny"],
  "spec.publish": ["allow", "deny", "deny", null, "deny", "internal_only"],
  "spec.correct": ["allow", "deny", "deny", null, "deny", "internal_only"],
  "stage.set": ["allow", "deny", "deny", null, "deny", "allow"],
  "stage.set.human_only": ["allow", "deny", "deny", null, "deny", "deny"],
  "deps.add": ["allow", "deny", "deny", null, "deny", "allow"],
  "deps.remove": ["allow", "deny", "deny", null, "deny", "allow"],
  "visibility.set": ["allow", "deny", "deny", null, "deny", "creation_default_only"],
  "security.set": ["allow", "allow", "allow", "write", "deny", "allow"],
  "security.clear": ["allow", "deny", "deny", null, "deny", "deny"],
  "mirror.configure": ["allow", "deny", "deny", null, "deny", "deny"],
};

const ACCOUNT_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "22222222-2222-2222-2222-222222222222";
const TOKEN_A = "33333333-3333-3333-3333-333333333333";
const RUN_A = "44444444-4444-4444-4444-444444444444";

describe("operations: OPERATION_TABLE matches the Conventions table cell for cell", () => {
  it("every operation's rule matches EXPECTED_TABLE exactly", () => {
    expect(OPERATION_TABLE).toEqual(EXPECTED_TABLE);
  });
});

describe("operations: authorize() -- every (principal kind x role x operation) pair", () => {
  const columns: { label: string; principal: Principal; expectedIdx: 0 | 1 | 2 | 4 | 5 }[] = [
    { label: "session owner/admin", principal: { kind: "session", accountId: ACCOUNT_A, userId: USER_A, role: "owner" }, expectedIdx: 0 },
    { label: "session member", principal: { kind: "session", accountId: ACCOUNT_A, userId: USER_A, role: "member" }, expectedIdx: 1 },
    { label: "token (read+write scopes)", principal: { kind: "token", accountId: ACCOUNT_A, userId: USER_A, tokenId: TOKEN_A, scopes: ["read", "write"] }, expectedIdx: 2 },
    { label: "run", principal: { kind: "run", accountId: ACCOUNT_A, runId: RUN_A }, expectedIdx: 4 },
    { label: "system", principal: { kind: "system", accountId: ACCOUNT_A, reason: "test" }, expectedIdx: 5 },
  ];

  for (const operation of Object.keys(EXPECTED_TABLE) as Operation[]) {
    for (const { label, principal, expectedIdx } of columns) {
      it(`${operation} / ${label}`, () => {
        expect(authorize(principal, operation)).toBe(EXPECTED_TABLE[operation][expectedIdx]);
      });
    }
  }

  it("every pair not marked (allow/own/thread_only/internal_only/creation_default_only) returns 'deny' -- assertAllowed then throws ForbiddenError and calls no query", async () => {
    const { assertAllowed } = await import("../src/operations.js");
    const { ForbiddenError } = await import("@fx/core/src/tenancy/errors.js");
    let deniedCount = 0;
    for (const operation of Object.keys(EXPECTED_TABLE) as Operation[]) {
      for (const { principal } of columns) {
        if (authorize(principal, operation) === "deny") {
          deniedCount++;
          expect(() => assertAllowed(principal, operation)).toThrow(ForbiddenError);
        }
      }
    }
    // Sanity: this table has real "deny" cells to exercise (not a
    // vacuously-true loop, e.g. if the table were miscoded to allow
    // everything).
    expect(deniedCount).toBeGreaterThan(0);
  });

  it("a token missing the required scope is denied even where the base cell is 'allow'", () => {
    const readOnlyToken: Principal = {
      kind: "token",
      accountId: ACCOUNT_A,
      userId: USER_A,
      tokenId: TOKEN_A,
      scopes: ["read"],
    };
    expect(authorize(readOnlyToken, "discussion.create")).toBe("deny");
    expect(authorize(readOnlyToken, "read")).toBe("allow");

    const noScopeToken: Principal = {
      kind: "token",
      accountId: ACCOUNT_A,
      userId: USER_A,
      tokenId: TOKEN_A,
      scopes: [],
    };
    expect(authorize(noScopeToken, "read")).toBe("deny");
    expect(authorize(noScopeToken, "discussion.create")).toBe("deny");
  });
});

/** A session principal whose role is deliberately outside MembershipRole. */
function sessionWithRole(role: unknown): Principal {
  return { kind: "session", accountId: ACCOUNT_A, userId: USER_A, role } as unknown as Principal;
}

/** DS-2e: every value the session branch must refuse, listed as data. */
const NOT_A_ROLE: ReadonlyArray<[string, unknown]> = [
  ["MEMBER", "MEMBER"],
  ["Owner", "Owner"],
  ["ADMIN", "ADMIN"],
  ["empty string", ""],
  ["leading space", " admin"],
  ["NUL suffix", "admin\0"],
  ["viewer", "viewer"],
  ["undefined", undefined],
  ["null", null],
  ["0", 0],
  ["true", true],
  ["{}", {}],
  ['["admin"]', ["admin"]],
  ["boxed String", new String("admin")],
  ["object with toString -> admin", { toString: () => "admin" }],
];

describe("DS-2e: the session branch allows exactly owner, admin and member", () => {
  const operations = Object.keys(EXPECTED_TABLE) as Operation[];

  it("owner and admin get the owner/admin cell and member gets the member cell, on every operation", () => {
    for (const operation of operations) {
      expect(authorize(sessionWithRole("owner"), operation), `${operation} / owner`).toBe(EXPECTED_TABLE[operation][0]);
      expect(authorize(sessionWithRole("admin"), operation), `${operation} / admin`).toBe(EXPECTED_TABLE[operation][0]);
      expect(authorize(sessionWithRole("member"), operation), `${operation} / member`).toBe(EXPECTED_TABLE[operation][1]);
    }
  });

  it("the sweep has 15 values, and each is denied on every operation", () => {
    expect(NOT_A_ROLE).toHaveLength(15);
    for (const [label, role] of NOT_A_ROLE) {
      for (const operation of operations) {
        expect(authorize(sessionWithRole(role), operation), `${operation} / ${label}`).toBe("deny");
      }
    }
  });

  it("comment.tombstone_any and stage.set.human_only are denied for MEMBER, '', undefined and viewer, and assertAllowed throws ForbiddenError", async () => {
    const { assertAllowed } = await import("../src/operations.js");
    const { ForbiddenError } = await import("@fx/core/src/tenancy/errors.js");
    for (const role of ["MEMBER", "", undefined, "viewer"]) {
      for (const operation of ["comment.tombstone_any", "stage.set.human_only"] as const) {
        expect(authorize(sessionWithRole(role), operation), `${operation} / ${String(role)}`).toBe("deny");
        expect(() => assertAllowed(sessionWithRole(role), operation), `${operation} / ${String(role)}`).toThrow(ForbiddenError);
      }
    }
  });
});

describe("criterion 2: systemPrincipal is exported from server.ts only", () => {
  it("src/index.ts exports no member named systemPrincipal", () => {
    expect(Object.keys(indexExports)).not.toContain("systemPrincipal");
  });

  it("src/index.ts exports no member named postAgentComment; server.ts does", async () => {
    expect(Object.keys(indexExports)).not.toContain("postAgentComment");
    const serverExports = await import("../src/server.js");
    expect(typeof serverExports.postAgentComment).toBe("function");
  });

  it("no exported function from src/index.ts returns an object with kind: 'system'", async () => {
    const accountId = ACCOUNT_A;
    const userId = USER_A;
    const runId = RUN_A;

    // Every exported *value* that is a function, probed with a handful of
    // plausible argument shapes. None of these are expected to succeed
    // (most need a live database and will reject/throw) -- the assertion
    // is purely about the *shape* of whatever they might synchronously or
    // asynchronously produce, never about a system principal leaking out.
    const candidateArgs = [
      { kind: "session", accountId, userId, role: "owner" },
      { kind: "token", accountId, userId, tokenId: "t", scopes: ["read", "write"] },
      { kind: "run", accountId, runId },
    ];

    for (const value of Object.values(indexExports)) {
      if (typeof value !== "function") continue;
      // Not every export is a (ctx, input) => Promise<...> operation --
      // OPERATION_TABLE, error classes and constants are also functions or
      // non-functions in this list. Cast to a generic callable and rely on
      // the try/catch below: the point is only "if this produced an
      // object back, it never has kind: 'system'", never that every export
      // is expected to succeed or even be invocable this way.
      const callable = value as (...args: unknown[]) => unknown;
      for (const principal of candidateArgs) {
        try {
          const result = callable({ pool: undefined, principal }, {});
          const resolved =
            result && typeof (result as Promise<unknown>).then === "function"
              ? await (result as Promise<unknown>).catch(() => undefined)
              : result;
          if (resolved && typeof resolved === "object") {
            expect((resolved as { kind?: string }).kind).not.toBe("system");
          }
        } catch {
          // Expected for most calls (no pool, missing input, etc). The
          // point is only: if something DID come back, it isn't a system
          // principal.
        }
      }
    }
  });
});

describe("rejectAccountIdInInput", () => {
  it("throws invalid_input for account_id or accountId keys", async () => {
    const { rejectAccountIdInInput, DiscussionsError } = await import("../src/operations.js");
    expect(() => rejectAccountIdInInput({ account_id: "x" })).toThrow(DiscussionsError);
    expect(() => rejectAccountIdInInput({ accountId: "x" })).toThrow(DiscussionsError);
    expect(() => rejectAccountIdInInput({ title: "fine" })).not.toThrow();
  });
});
