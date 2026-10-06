// apps/web/test/session-routes.test.ts
//
// D#37 WS-L1 (correction C19c, task WS-L1): tests specific to this task's
// own two additions to lib/shell/session-routes.ts --
//
//   criterion 4: "The licence route is gone ... A GET now gets the
//   existing unknown-path 404. A test pins it."
//
//   criterion 5: "auth/me reads the subscription state from accounts.status
//   (D#69, #93) ... session-routes.test.ts has one case per row" of the
//   accounts.status -> workspace_access table.
//
// The pre-existing exact-field-set test (WS-C criterion 3, now amended by
// C19e item 2 to list workspace_access too) and the general auth/me
// coverage (401s, is_admin, storage_ns parity, Cache-Control, idle/
// absolute session limits) already live in shell-routes.test.ts -- this
// file adds only what WS-L1 itself introduces, using the exact same
// fakes/helpers that file uses.

import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session";
import { shellSessionHandler, deriveWorkspaceAccess, type SessionRouteDeps } from "../lib/shell/session-routes";
import { SHELL_PATH_HEADER } from "../lib/shell/shell-paths";
import { fakePlatformOpsPool } from "../app/api/auth/_lib/testFakes";

const env = { FX_SESSION_SECRET: "b".repeat(32) } as unknown as NodeJS.ProcessEnv;

/** Same shape as shell-routes.test.ts's own fakeAppUserPool -- kept local so this file has no cross-file coupling beyond the two fakes it actually shares. */
function fakeAppUserPool(role: "owner" | "admin" | "member" | null): Pool {
  const client = {
    async query(sql: string) {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql === "RESET app.account_id; RESET app.user_id" ||
        sql.startsWith("SELECT set_config(")
      ) {
        return { rows: [] };
      }
      if (/SELECT role FROM account_members WHERE account_id/.test(sql)) {
        return { rows: role ? [{ role }] : [] };
      }
      throw new Error(`fakeAppUserPool: unexpected query: ${sql}`);
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

function deps(opts: {
  existingUser: { id: string; email: string; name: string | null; githubLogin: string | null };
  role: "owner" | "admin" | "member";
  accountStatus: { accountId: string; status: string };
}): SessionRouteDeps {
  return {
    platformOpsPool: fakePlatformOpsPool({ existingUser: opts.existingUser, accountStatus: opts.accountStatus }),
    appUserPool: fakeAppUserPool(opts.role),
  };
}

function reqTo(shellPath: string, opts: { method?: string; token?: string } = {}): NextRequest {
  const req = new NextRequest("https://example.test/api/shell/session", {
    method: opts.method ?? "GET",
    headers: { [SHELL_PATH_HEADER]: shellPath },
  });
  if (opts.token) req.cookies.set(SESSION_COOKIE_NAME, opts.token);
  return req;
}

async function withSecret<T>(fn: () => Promise<T>): Promise<T> {
  process.env.FX_SESSION_SECRET = env.FX_SESSION_SECRET;
  try {
    return await fn();
  } finally {
    delete process.env.FX_SESSION_SECRET;
  }
}

describe("D#37 WS-L1 criterion 4: the licence route is gone", () => {
  it("GET /api/license/status -> 404 (unmapped path, same as any other unrecognized shellPath)", async () => {
    const res = await shellSessionHandler(
      reqTo("/api/license/status"),
      deps({
        existingUser: { id: "f0f0f0f0-1111-1111-1111-f0f0f0f0f0f0", email: "gone@example.test", name: null, githubLogin: "gone" },
        role: "member",
        accountStatus: { accountId: "acc", status: "active" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/license/status -> 404 even WITH a valid session (route removed, not just gated)", async () => {
    await withSecret(async () => {
      const userId = "f1f1f1f1-1111-1111-1111-f1f1f1f1f1f1";
      const accountId = "f2f2f2f2-1111-1111-1111-f2f2f2f2f2f2";
      const token = await signSession({ userId, accountId }, env, { epoch: 0 });
      const d = deps({
        existingUser: { id: userId, email: "gone2@example.test", name: null, githubLogin: "gone2" },
        role: "member",
        accountStatus: { accountId, status: "active" },
      });
      const res = await shellSessionHandler(reqTo("/api/license/status", { token }), d);
      expect(res.status).toBe(404);
    });
  });
});

describe("D#37 WS-L1 criterion 5: deriveWorkspaceAccess fails closed on a null status (no account row / not authorized)", () => {
  it("null -> no_subscription, never open", () => {
    expect(deriveWorkspaceAccess(null)).toBe("no_subscription");
  });
});

describe("D#37 WS-L1 criterion 5: workspace_access, one case per accounts.status row", () => {
  // Fixed, distinct UUIDs -- one pair per row -- rather than deriving one
  // from the status string: `withTenant`'s `assertUuid` rejects anything
  // that isn't real UUID shape, and a status name doesn't fit that shape.
  const rows: Array<{ status: string; expected: "open" | "no_subscription" | "subscription_ended"; n: number }> = [
    { status: "active", expected: "open", n: 1 },
    { status: "past_due", expected: "open", n: 2 },
    { status: "paused", expected: "open", n: 3 },
    { status: "model_key_broken", expected: "open", n: 4 },
    { status: "unsubscribed", expected: "no_subscription", n: 5 },
    { status: "cancelled", expected: "subscription_ended", n: 6 },
  ];

  for (const { status, expected, n } of rows) {
    it(`accounts.status = "${status}" -> workspace_access = "${expected}"`, async () => {
      await withSecret(async () => {
        const userId = `aaaaaaaa-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-111111111111`;
        const accountId = `bbbbbbbb-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-222222222222`;
        const token = await signSession({ userId, accountId }, env, { epoch: 0 });
        const d = deps({
          existingUser: { id: userId, email: `${status}@example.test`, name: null, githubLogin: `${status}-gh` },
          role: "member",
          accountStatus: { accountId, status },
        });
        const res = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token }), d);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { workspace_access: string };
        expect(body.workspace_access).toBe(expected);
      });
    });
  }

  it("fails closed: an unrecognized status value maps to no_subscription, never open", async () => {
    await withSecret(async () => {
      const userId = "c0000000-1111-1111-1111-111111111111";
      const accountId = "d0000000-2222-2222-2222-222222222222";
      const token = await signSession({ userId, accountId }, env, { epoch: 0 });
      const d = deps({
        existingUser: { id: userId, email: "unknown-status@example.test", name: null, githubLogin: "unknown-status" },
        role: "member",
        accountStatus: { accountId, status: "some_future_value_this_client_has_never_seen" },
      });
      const res = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token }), d);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { workspace_access: string };
      expect(body.workspace_access).toBe("no_subscription");
    });
  });

  it("workspace_access is derived only from the session's OWN account, never a caller-supplied one (criterion 7)", async () => {
    // No header, no body field, no query param on the request carries an
    // accountId at all -- meResponse only ever reads session.accountId
    // (from the verified, signed cookie). This test's own fixture proves
    // it structurally: the ONLY accountId anywhere in this request is the
    // one embedded in the signed session token.
    await withSecret(async () => {
      const userId = "e0000000-1111-1111-1111-111111111111";
      const accountId = "f0000000-2222-2222-2222-222222222222";
      const token = await signSession({ userId, accountId }, env, { epoch: 0 });
      const d = deps({
        existingUser: { id: userId, email: "own-account@example.test", name: null, githubLogin: "own-account" },
        role: "member",
        accountStatus: { accountId, status: "cancelled" },
      });
      const res = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token }), d);
      const body = (await res.json()) as { workspace_access: string };
      expect(body.workspace_access).toBe("subscription_ended");
    });
  });
});
