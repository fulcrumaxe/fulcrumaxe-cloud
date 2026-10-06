import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import type { Pool } from "pg";
import { authorize, OPERATION_TABLE, type Operation } from "../src/operations.js";
import { actingUserId, actorForWrite, isHumanOnly, redactIfNeeded, type Principal } from "../src/principals.js";
import { createDiscussion, reviseDiscussion, setVisibility, setSecurity, clearSecurity } from "../src/discussions.js";
import {
  postComment,
  postAgentComment,
  editOwnComment,
  tombstoneComment,
} from "../src/comments.js";
import { publishSpec, addCorrection, specAsOf, correctionsSince } from "../src/specs.js";
import { setStage } from "../src/stages.js";
import { addDependency, removeDependency } from "../src/deps.js";

/**
 * Follow-up hardening: every read of a principal field (kind, accountId,
 * userId, runId, role) must be an OWN DATA property. Object.prototype is
 * polluted below; a principal that lacks the own field is refused with
 * ForbiddenError and the fake pool proves nothing was queried with the
 * inherited value.
 */
const POLLUTED = "99999999-9999-4999-8999-999999999999";
const A = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";
const W = "44444444-4444-4444-8444-444444444444";
const R = "55555555-5555-4555-8555-555555555555";

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
  const restore = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(Object.prototype, k, d);
      else delete (Object.prototype as Record<string, unknown>)[k];
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

/** A pool that records every call; nothing ever reaches a database. */
function fakePool(rows: unknown[] = []) {
  const calls: unknown[] = [];
  const client = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { rows, rowCount: rows.length };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => {
      calls.push(["connect"]);
      return client;
    },
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, calls };
}

type Call = (pool: Pool, principal: Principal) => Promise<unknown>;

const BODY = "a body";
// Each entry: a principal kind allowed to attempt the operation (so the
// refusal comes from the own-field read, not from the operation table).
const ACCOUNT_CALLS: Array<[string, "session" | "system", Call]> = [
  ["createDiscussion", "session", (pool, principal) => createDiscussion({ pool, principal }, { title: "t", kind: "feature", body: BODY })],
  ["reviseDiscussion", "session", (pool, principal) => reviseDiscussion({ pool, principal }, { discussionId: D, body: BODY })],
  ["setVisibility", "session", (pool, principal) => setVisibility({ pool, principal }, { discussionId: D, visibility: "private" })],
  ["setSecurity", "session", (pool, principal) => setSecurity({ pool, principal }, { discussionId: D })],
  ["clearSecurity", "session", (pool, principal) => clearSecurity({ pool, principal }, { discussionId: D })],
  ["postComment", "session", (pool, principal) => postComment({ pool, principal }, { discussionId: D, body: BODY })],
  ["postAgentComment", "system", (pool, principal) => postAgentComment({ pool, principal }, { discussionId: D, agentRunId: R, body: BODY })],
  ["editOwnComment", "session", (pool, principal) => editOwnComment({ pool, principal }, { commentId: D, body: BODY })],
  ["tombstoneComment", "session", (pool, principal) => tombstoneComment({ pool, principal }, { commentId: D })],
  ["publishSpec", "session", (pool, principal) => publishSpec({ pool, principal }, { workItemId: W, body: BODY })],
  ["addCorrection", "session", (pool, principal) => addCorrection({ pool, principal }, { workItemId: W, body: BODY })],
  ["specAsOf", "session", (pool, principal) => specAsOf({ pool, principal }, { runId: R })],
  ["correctionsSince", "session", (pool, principal) => correctionsSince({ pool, principal }, { runId: R })],
  ["setStage", "session", (pool, principal) => setStage({ pool, principal }, { workItemId: W, toStage: "in_progress" } as never)],
  ["addDependency", "session", (pool, principal) => addDependency({ pool, principal }, { workItemId: W, dependsOnId: D })],
  ["removeDependency", "session", (pool, principal) => removeDependency({ pool, principal }, { workItemId: W, dependsOnId: D })],
];

function seen(calls: unknown[]): boolean {
  return JSON.stringify(calls).includes(POLLUTED);
}

function accessorPrincipal(base: object, key: string, value: unknown): Principal {
  // Built before any pollution so the descriptor literal cannot inherit `value`.
  const p = { ...base } as Record<string, unknown>;
  Object.defineProperty(p, key, { get: () => value, enumerable: true, configurable: true });
  return p as unknown as Principal;
}

describe("ownField reads only own DATA descriptors", () => {
  it("an own accessor role is denied even with Object.prototype.value polluted", () => {
    const p = accessorPrincipal({ kind: "session", accountId: A, userId: U }, "role", "owner");
    withPollution({ value: "owner" }, () => {
      for (const op of Object.keys(OPERATION_TABLE) as Operation[]) expect(authorize(p, op), op).toBe("deny");
      expect(isHumanOnly(p)).toBe(false);
    });
  });

  it("an own accessor kind is denied with Object.prototype.value polluted", () => {
    const k = accessorPrincipal({ accountId: A }, "kind", "system");
    withPollution({ value: "system" }, () => {
      for (const op of Object.keys(OPERATION_TABLE) as Operation[]) expect(authorize(k, op), op).toBe("deny");
    });
  });
});

describe("principal fields other than kind/role/scopes are own-data only", () => {
  for (const [name, kind, call] of ACCOUNT_CALLS) {
    it(`${name}: inherited accountId is refused and never queried`, async () => {
      const { pool, calls } = fakePool();
      await withPollution({ accountId: POLLUTED, userId: POLLUTED, runId: POLLUTED }, async () => {
        const principal =
          kind === "system"
            ? ({ kind: "system", reason: "test" } as unknown as Principal)
            : ({ kind: "session", role: "owner", userId: U } as unknown as Principal);
        await expect(call(pool, principal)).rejects.toBeInstanceOf(ForbiddenError);
      });
      expect(seen(calls)).toBe(false);
      expect(calls).toEqual([]);
    });
  }

  it("session and token principals with an inherited userId act as no one and are refused", async () => {
    await withPollution({ userId: POLLUTED }, async () => {
      for (const kind of ["session", "token"]) {
        const p = { kind, accountId: A, role: "owner", scopes: ["read", "write"], tokenId: A } as unknown as Principal;
        expect(() => actingUserId(p)).toThrow(ForbiddenError);
        expect(() => actorForWrite(p)).toThrow(ForbiddenError);
      }
      const { pool, calls } = fakePool();
      const session = { kind: "session", accountId: A, role: "member" } as unknown as Principal;
      await expect(
        editOwnComment({ pool, principal: session }, { commentId: D, body: BODY }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        createDiscussion(
          { pool, principal: { kind: "session", accountId: A, role: "owner" } as unknown as Principal },
          { title: "t", kind: "feature", body: BODY },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(seen(calls)).toBe(false);
    });
  });

  it("a run principal with an inherited runId is refused and its runId never queried", async () => {
    await withPollution({ runId: POLLUTED }, async () => {
      // Every query answers with a plausible row so the code reaches its own-runId read.
      const { pool, calls } = fakePool([{ work_item_id: W, spec_version_id: D, spec_work_item_id: W, role: "x" }]);
      const principal = { kind: "run", accountId: A } as unknown as Principal;
      await expect(postComment({ pool, principal }, { discussionId: D, body: BODY })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(specAsOf({ pool, principal }, { runId: R })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(correctionsSince({ pool, principal }, { runId: R })).rejects.toBeInstanceOf(ForbiddenError);
      expect(seen(calls)).toBe(false);
    });
  });

  it("a principal with an inherited kind does not have its body redacted or trusted", () => {
    withPollution({ kind: "session" }, () => {
      const p = { accountId: A } as unknown as Principal;
      expect(() => redactIfNeeded(p, "x")).not.toThrow();
      expect(actorForWrite(p)).toEqual({ kind: "user", userId: null });
    });
  });

  it("own fields still work while the prototype is polluted", async () => {
    await withPollution({ accountId: POLLUTED, userId: POLLUTED, runId: POLLUTED }, async () => {
      const s: Principal = { kind: "session", accountId: A, userId: U, role: "owner" };
      expect(actingUserId(s)).toBe(U);
      const { pool, calls } = fakePool();
      await setSecurity({ pool, principal: s }, { discussionId: D }).catch(() => undefined);
      expect(calls.length).toBeGreaterThan(0);
      expect(seen(calls)).toBe(false);
    });
  });

  it("restores the prototype", () => {
    for (const k of ["value", "accountId", "userId", "runId", "kind", "role"]) {
      expect(Object.hasOwn(Object.prototype, k), k).toBe(false);
    }
  });
});
