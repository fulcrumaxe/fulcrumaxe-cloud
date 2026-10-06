import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session";
import { GET as modeGET, dynamic as modeDynamic } from "../app/api/mode/route";
import { GET as systemModeGET, dynamic as systemModeDynamic } from "../app/api/system/mode/route";
import { GET as brandingGET, dynamic as brandingDynamic } from "../app/api/branding/route";
import { listPlans } from "@fx/billing";
import { resetPlanDataCache } from "@fx/plan-data";
import { shellSessionHandler, type SessionRouteDeps } from "../lib/shell/session-routes";
import { SHELL_PATH_HEADER } from "../lib/shell/shell-paths";
import { fakePlatformOpsPool } from "../app/api/auth/_lib/testFakes";
import { signOutHandler } from "../app/api/auth/signout/handler";

const env = { FX_SESSION_SECRET: "a".repeat(32) } as unknown as NodeJS.ProcessEnv;

/**
 * A fake app_user pool answering exactly the one query
 * `getMemberRole` (packages/core/src/tenancy/authorize.ts, via
 * `withTenant`) issues, plus the `BEGIN`/`set_config`/`COMMIT`/`RESET`
 * bracket withTenant wraps every call in.
 */
function fakeAppUserPool(role: "owner" | "admin" | "member" | null, partnerBilled = false): Pool {
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
      // D#37 WS-F6: the plan list's one account read (is a partner billing this account?).
      if (/^SELECT \(partner_id IS NOT NULL\) AS partner_billed FROM accounts WHERE id = \$1$/.test(sql)) {
        return { rows: [{ partner_billed: partnerBilled }] };
      }
      throw new Error(`fakeAppUserPool: unexpected query: ${sql}`);
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

function deps(opts: {
  existingUser?: {
    id: string;
    email: string;
    name: string | null;
    sessionEpoch?: number;
    githubLogin?: string | null;
  } | null;
  role?: "owner" | "admin" | "member" | null;
  /** D#37 WS-F6: the account read behind the plan list's `viewer.partner_billed`. */
  partnerBilled?: boolean;
  /** D#37 WS-L1: seeds workspace_access's own account-status read. Omitted -> "active" (workspace_access: "open"), same as before this field existed. */
  accountStatus?: { accountId: string; status: string } | null;
} = {}): SessionRouteDeps {
  return {
    platformOpsPool: fakePlatformOpsPool({
      existingUser: opts.existingUser ?? null,
      accountStatus: opts.accountStatus ?? null,
    }),
    appUserPool: fakeAppUserPool(opts.role ?? null, opts.partnerBilled ?? false),
  };
}

function reqTo(shellPath: string, opts: { method?: string; token?: string } = {}): NextRequest {
  // Simulates what middleware's shellSessionRewriteStep hands the route
  // handler: a request to /api/shell/session carrying the original path
  // in SHELL_PATH_HEADER, not a query parameter (see shell-paths.ts's
  // header comment for why).
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

describe("D#37 WS-C criterion 2: static anonymous contract routes", () => {
  it("GET /api/mode returns the static cloud-profile body, force-static, no version/env/host/account data", async () => {
    expect(modeDynamic).toBe("force-static");
    const body = await modeGET().json();
    expect(body).toEqual({
      mode: "cloud",
      profile: "cloud",
      features: { presence: false, liveEntitlements: false, crdt: false, messages: false, updates: false },
    });
  });

  it("GET /api/system/mode returns {cloud:true}, force-static", async () => {
    expect(systemModeDynamic).toBe("force-static");
    expect(await systemModeGET().json()).toEqual({ cloud: true });
  });

  it("GET /api/branding returns static branding, force-static, no host/env data", async () => {
    // D#37 Correction C19d / WS-B1 criterion 1: the route now returns the
    // six branding keys the shell actually reads, not name/shortName --
    // see apps/web/test/branding.test.ts for the full pin of this body.
    expect(brandingDynamic).toBe("force-static");
    const body = await brandingGET().json();
    expect(body).toEqual({
      page_title: "fulcrumaxe",
      product_name: "fulcrumaxe cloud",
      os_name: "fulcrumaxe cloud",
      system_tag: "fulcrumaxe cloud",
      copyright: "© fulcrumaxe",
      welcome_message: "Welcome to fulcrumaxe cloud.",
    });
  });
});

describe("D#37 WS-C criterion 3: /api/cloud/auth/me and /api/profile (via the shared session route)", () => {
  for (const shellPath of ["/api/cloud/auth/me", "/api/profile"]) {
    it(`${shellPath} without a session -> 401, empty body`, async () => {
      const res = await shellSessionHandler(reqTo(shellPath), deps());
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    it(`${shellPath} with a session -> only username, email, is_admin, id, storage_ns, workspace_access -- no account_id/token/session id/DB id/Stripe id/plan/price/status string`, async () => {
      await withSecret(async () => {
        const userId = "11111111-1111-1111-1111-111111111111";
        const accountId = "22222222-2222-2222-2222-222222222222";
        const token = await signSession({ userId, accountId }, env, { epoch: 0 });
        const d = deps({
          existingUser: { id: userId, email: "a@example.test", name: "Ada", githubLogin: "ada-gh" },
          role: "owner",
          accountStatus: { accountId, status: "active" },
        });
        const res = await shellSessionHandler(reqTo(shellPath, { token }), d);
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        // D#37 WS-L1 (correction C19e item 2): "the allowed fields gain
        // workspace_access. Nothing else changes."
        expect(Object.keys(body).sort()).toEqual([
          "email",
          "id",
          "is_admin",
          "storage_ns",
          "username",
          "workspace_access",
        ]);
        expect(body.username).toBe("ada-gh");
        expect(body.email).toBe("a@example.test");
        expect(body.is_admin).toBe(true);
        expect(body.id).not.toBe(userId);
        expect(body.id).not.toBe("1");
        expect(typeof body.storage_ns).toBe("string");
        expect(body.workspace_access).toBe("open");
        // Explicitly assert the forbidden fields are absent by name, not
        // just "not in the key list" -- guards against a future rename
        // that adds e.g. `accountId` (camelCase) sneaking past the
        // sorted-keys check above.
        expect(body).not.toHaveProperty("account_id");
        expect(body).not.toHaveProperty("accountId");
        expect(body).not.toHaveProperty("token");
        expect(body).not.toHaveProperty("session_id");
        expect(body).not.toHaveProperty("sid");
        expect(body).not.toHaveProperty("stripe_id");
        expect(body).not.toHaveProperty("plan");
        expect(body).not.toHaveProperty("status");
      });
    });

    it(`${shellPath} is_admin is false for a plain member`, async () => {
      await withSecret(async () => {
        const userId = "33333333-3333-3333-3333-333333333333";
        const accountId = "44444444-4444-4444-4444-444444444444";
        const token = await signSession({ userId, accountId }, env, { epoch: 0 });
        const d = deps({
          existingUser: { id: userId, email: "m@example.test", name: null, githubLogin: "m-gh" },
          role: "member",
        });
        const res = await shellSessionHandler(reqTo(shellPath, { token }), d);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.is_admin).toBe(false);
      });
    });

    it(`${shellPath} without a stored github_login -> 401 (fail closed, never a default username)`, async () => {
      await withSecret(async () => {
        const userId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
        const accountId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
        const token = await signSession({ userId, accountId }, env, { epoch: 0 });
        const d = deps({
          existingUser: { id: userId, email: "nologin@example.test", name: null, githubLogin: null },
          role: "member",
        });
        const res = await shellSessionHandler(reqTo(shellPath, { token }), d);
        expect(res.status).toBe(401);
        expect(await res.text()).toBe("");
      });
    });

    it(`${shellPath} carries Cache-Control: private, no-store`, async () => {
      const res = await shellSessionHandler(reqTo(shellPath), deps());
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
  }

  it("the same account gets the same storage_ns on both aliases (me/profile agree)", async () => {
    await withSecret(async () => {
      const userId = "55555555-5555-5555-5555-555555555555";
      const accountId = "66666666-6666-6666-6666-666666666666";
      const token = await signSession({ userId, accountId }, env, { epoch: 0 });
      const d = deps({
        existingUser: { id: userId, email: "s@example.test", name: null, githubLogin: "s-gh" },
        role: "owner",
      });
      const meBody = (await (await shellSessionHandler(reqTo("/api/cloud/auth/me", { token }), d)).json()) as {
        storage_ns: string;
      };
      const profileBody = (await (await shellSessionHandler(reqTo("/api/profile", { token }), d)).json()) as {
        storage_ns: string;
      };
      expect(meBody.storage_ns).toBe(profileBody.storage_ns);
    });
  });
});

describe("D#37 WS-C criterion 4: entitlements/license/preferences placeholders", () => {
  it("GET /api/entitlements/me without a session -> 401, empty body", async () => {
    const res = await shellSessionHandler(reqTo("/api/entitlements/me"), deps());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  // D#37 WS-F6 criterion 2: the real mapping, one test per workspace_access state.
  const ENTITLEMENT_CASES: [string, "allow" | "deny"][] = [
    ["active", "allow"],
    ["past_due", "allow"],
    ["paused", "allow"],
    ["model_key_broken", "allow"],
    ["unsubscribed", "deny"],
    ["cancelled", "deny"],
    ["some_future_status", "deny"],
  ];
  for (const [status, expected] of ENTITLEMENT_CASES) {
    it(`GET /api/entitlements/me with account status ${status} -> default ${expected}, no per-app entry`, async () => {
      await withSecret(async () => {
        const userId = "77777777-7777-7777-7777-777777777777";
        const accountId = "78787878-7878-7878-7878-787878787878";
        const token = await signSession({ userId, accountId }, env, { epoch: 0 });
        const d = deps({
          existingUser: { id: userId, email: "e@example.test", name: null },
          role: "member",
          accountStatus: { accountId, status },
        });
        const res = await shellSessionHandler(reqTo("/api/entitlements/me", { token }), d);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ entitlements: {}, default: expected });
        expect(res.headers.get("cache-control")).toBe("private, no-store");
      });
    });
  }

  it("GET /api/preferences with a session -> {}", async () => {
    await withSecret(async () => {
      const userId = "99999999-9999-9999-9999-999999999999";
      const token = await signSession({ userId, accountId: "99999999-9999-9999-9999-999999999999" }, env, { epoch: 0 });
      const d = deps({ existingUser: { id: userId, email: "p@example.test", name: null }, role: "member" });
      const res = await shellSessionHandler(reqTo("/api/preferences", { token }), d);
      expect(await res.json()).toEqual({});
    });
  });

  // Security fix round item 3 (CWE-525).
  it("GET /api/preferences carries Cache-Control: private, no-store", async () => {
    await withSecret(async () => {
      const userId = "99999999-1111-1111-1111-999999999999";
      const token = await signSession({ userId, accountId: "acc" }, env, { epoch: 0 });
      const d = deps({ existingUser: { id: userId, email: "p2@example.test", name: null }, role: "member" });
      const res = await shellSessionHandler(reqTo("/api/preferences", { token }), d);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
  });

  it("POST /api/preferences with a session -> 204", async () => {
    await withSecret(async () => {
      const userId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const token = await signSession({ userId, accountId: "acc" }, env, { epoch: 0 });
      const d = deps({ existingUser: { id: userId, email: "pp@example.test", name: null }, role: "member" });
      const res = await shellSessionHandler(reqTo("/api/preferences", { method: "POST", token }), d);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });
  });

  // Security fix round item 3 (CWE-525).
  it("POST /api/preferences carries Cache-Control: private, no-store", async () => {
    await withSecret(async () => {
      const userId = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
      const token = await signSession({ userId, accountId: "acc" }, env, { epoch: 0 });
      const d = deps({ existingUser: { id: userId, email: "pp2@example.test", name: null }, role: "member" });
      const res = await shellSessionHandler(reqTo("/api/preferences", { method: "POST", token }), d);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
  });
});

describe("D#37 WS-F6 (G1): GET /api/plans, the plan list read from the plan source", () => {
  async function plansAs(role: "owner" | "admin" | "member", partnerBilled = false) {
    return withSecret(async () => {
      const userId = "88888888-8888-8888-8888-888888888888";
      const token = await signSession({ userId, accountId: "99999999-9999-9999-9999-999999999999" }, env, { epoch: 0 });
      const d = deps({ existingUser: { id: userId, email: "p@example.test", name: null }, role, partnerBilled });
      return shellSessionHandler(reqTo("/api/plans", { token }), d);
    });
  }

  it("without a session -> 401, empty body", async () => {
    const res = await shellSessionHandler(reqTo("/api/plans"), deps());
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("matches the plan data field by field: same ids in the same order, every value from the source", async () => {
    const res = await plansAs("owner");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { plans: Record<string, unknown>[] };
    const source = listPlans();
    expect(body.plans.map((p) => p.id)).toEqual(source.map((p) => p.id));
    source.forEach((p, i) => {
      const got = body.plans[i]!;
      expect(got.price_usd_month).toBe(p.priceUsdPerMonth);
      expect(got.repo_limit).toBe(p.repoLimit);
      expect(got.always_on_security_reviewer).toBe(p.alwaysOnSecurityReviewer);
      expect(got.priority_queue).toBe(p.priorityQueue);
      expect(got.compute_cap_usd_month).toBe(p.computeCapUsdPerMonth);
      expect(got.foreground_compute_usd_month).toBe(p.foreground.usdPerMonth);
      const bg = got.background_compute as Record<string, unknown>;
      if (p.background.kind === "flat") {
        expect(bg).toEqual({ kind: "flat", usd_month: p.background.usdPerMonth });
      } else {
        expect(bg).toEqual({
          kind: "scaling",
          base_usd_month: p.background.baseUsdPerMonth,
          per_repo_usd_month: p.background.perRepoUsdPerMonth,
          ceiling_usd_month: p.background.ceilingUsdPerMonth,
        });
      }
    });
    // Nothing else leaks from the plan source (rate limits, webhook caps).
    expect(Object.keys(body.plans[0]!).sort()).toEqual([
      "always_on_security_reviewer",
      "background_compute",
      "compute_cap_usd_month",
      "foreground_compute_usd_month",
      "id",
      "price_usd_month",
      "priority_queue",
      "repo_limit",
    ]);
  });

  it("with the plan data unavailable -> 503 plan_data_unavailable, a plain message, never a default list", async () => {
    const saved = process.env.FX_PLAN_DATA;
    try {
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      const res = await plansAs("owner");
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toEqual({ error: { code: "plan_data_unavailable", message: "Plans are unavailable right now" } });
    } finally {
      if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it("viewer.is_owner is true only for the owner; admin and member are false", async () => {
    for (const [role, expected] of [["owner", true], ["admin", false], ["member", false]] as const) {
      const body = (await (await plansAs(role)).json()) as { viewer: { is_owner: boolean; partner_billed: boolean } };
      expect(body.viewer).toEqual({ is_owner: expected, partner_billed: false });
    }
  });

  it("viewer.partner_billed follows the account read", async () => {
    const body = (await (await plansAs("owner", true)).json()) as { viewer: { partner_billed: boolean } };
    expect(body.viewer.partner_billed).toBe(true);
  });
});

describe("D#37 WS-C criterion 8: sign-out-everywhere epoch re-check", () => {
  it("a session signed under epoch 0 is rejected once the live epoch has moved to 1", async () => {
    await withSecret(async () => {
      const userId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const token = await signSession({ userId, accountId: "acc" }, env, { epoch: 0 });
      // The live users row is seeded at sessionEpoch: 1 (as if
      // bumpSessionEpoch already ran once, e.g. via a "sign out
      // everywhere" call) while the token above still embeds epoch 0.
      const d = deps({ existingUser: { id: userId, email: "z@example.test", name: null, sessionEpoch: 1 }, role: "member" });
      const res = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token }), d);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });
  });
});

/**
 * D#37 WS-C2 fix round item 1 (E1, CWE-613, correction C15a) MUST-FIX
 * test: "sign at epoch 0, POST {} to sign-out, replay on
 * /api/cloud/auth/me, expect 401 with an empty body; the user's other
 * session still gets 200, and both get 401 with everywhere." Runs
 * against the REAL handlers (signOutHandler and shellSessionHandler,
 * both under test throughout this file), not a stub -- the same shared
 * `resolveActiveSession`/`revokeSession`/`getSessionEpochAndRevocation`
 * every production request path uses.
 */
describe("D#37 WS-C2 fix round item 1 (correction C15a): per-session revocation replay", () => {
  it("sign-out revokes only the signed-out session; everywhere revokes both", async () => {
    await withSecret(async () => {
      const userId = "eeeeeeee-1111-1111-1111-eeeeeeeeeeee";
      const d = deps({
        existingUser: { id: userId, email: "revoke@example.test", name: null, githubLogin: "revoke-me" },
        role: "member",
      });

      // Two independent sessions for the SAME user -- signSession mints
      // a fresh sid every call, so tokenA and tokenB are distinct
      // sessions even though both embed epoch 0 for the same userId.
      const accountId = "ffffffff-1111-1111-1111-ffffffffffff";
      const tokenA = await signSession({ userId, accountId }, env, { epoch: 0 });
      const tokenB = await signSession({ userId, accountId }, env, { epoch: 0 });

      // Plain sign-out (no everywhere) on session A only.
      const signOutReqA = new NextRequest("https://example.test/api/auth/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      signOutReqA.cookies.set(SESSION_COOKIE_NAME, tokenA);
      const signOutResA = await signOutHandler(signOutReqA, d.platformOpsPool);
      expect(signOutResA.status).toBe(200);

      // Replay A on /api/cloud/auth/me -> 401, empty body.
      const replayA = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token: tokenA }), d);
      expect(replayA.status).toBe(401);
      expect(await replayA.text()).toBe("");

      // B is untouched by A's plain sign-out -> still 200.
      const replayB = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token: tokenB }), d);
      expect(replayB.status).toBe(200);

      // Sign-out B with everywhere:true -- revokes B directly AND bumps
      // the epoch, which also catches A a second, independent way.
      const signOutReqB = new NextRequest("https://example.test/api/auth/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ everywhere: true }),
      });
      signOutReqB.cookies.set(SESSION_COOKIE_NAME, tokenB);
      const signOutResB = await signOutHandler(signOutReqB, d.platformOpsPool);
      expect(signOutResB.status).toBe(200);

      // Both A and B now get 401.
      const replayAAfterEverywhere = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token: tokenA }), d);
      expect(replayAAfterEverywhere.status).toBe(401);
      expect(await replayAAfterEverywhere.text()).toBe("");

      const replayBAfterEverywhere = await shellSessionHandler(reqTo("/api/cloud/auth/me", { token: tokenB }), d);
      expect(replayBAfterEverywhere.status).toBe(401);
      expect(await replayBAfterEverywhere.text()).toBe("");
    });
  });
});

describe("D#37 WS-C criterion 8: the idle limit slides with activity, absolute limit never exceeded (fake clock)", () => {
  const start = 1_700_000_000_000;

  /** Reads the refreshed session cookie shellSessionHandler set on `res` (security fix round item 4 -- resolveActiveSession wires refreshSession in, and session-routes.ts applies it via applyRefreshedSessionCookie). */
  function refreshedToken(res: NextResponse): string {
    const cookie = res.cookies.get(SESSION_COOKIE_NAME);
    if (!cookie) throw new Error("expected shellSessionHandler to have set a refreshed session cookie");
    return cookie.value;
  }

  it("(a) activity at 23h keeps the session alive past the original 24h idle deadline", async () => {
    await withSecret(async () => {
      const userId = "e0e0e0e0-1111-1111-1111-111111111111";
      const d = deps({ existingUser: { id: userId, email: "idle-a@example.test", name: null }, role: "member" });
      const initialToken = await signSession({ userId, accountId: "acc" }, env, { epoch: 0, now: () => start });

      // Activity at +23h, still inside the default 24h idle window.
      const at23h = await shellSessionHandler(reqTo("/api/preferences", { token: initialToken }), d, {
        now: () => start + 23 * 60 * 60 * 1000,
      });
      expect(at23h.status).toBe(200);
      const slid = refreshedToken(at23h);

      // Without the refresh above, the ORIGINAL token would already be
      // expired at +25h (past its original +24h deadline). Replaying
      // the SLID token from the +23h activity at +25h still succeeds,
      // because that activity pushed the idle deadline to +23h+24h.
      const at25h = await shellSessionHandler(reqTo("/api/preferences", { token: slid }), d, {
        now: () => start + 25 * 60 * 60 * 1000,
      });
      expect(at25h.status).toBe(200);
    });
  });

  it("(b) no activity for more than 24h gives 401", async () => {
    await withSecret(async () => {
      const userId = "e1e1e1e1-1111-1111-1111-111111111111";
      const d = deps({ existingUser: { id: userId, email: "idle-b@example.test", name: null }, role: "member" });
      const token = await signSession({ userId, accountId: "acc" }, env, { epoch: 0, now: () => start });

      const res = await shellSessionHandler(reqTo("/api/preferences", { token }), d, {
        now: () => start + 25 * 60 * 60 * 1000,
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });
  });

  it("(c) continuous activity still ends at the absolute limit", async () => {
    await withSecret(async () => {
      // A compressed idle/absolute pair (1h / 2h) keeps this test fast
      // and deterministic while exercising the same logic as the real
      // 24h/30d defaults.
      const shortEnv = {
        ...env,
        FX_SESSION_IDLE_SECONDS: "3600",
        FX_SESSION_ABSOLUTE_SECONDS: "7200",
      } as unknown as NodeJS.ProcessEnv;
      const userId = "e2e2e2e2-1111-1111-1111-111111111111";
      const d = deps({ existingUser: { id: userId, email: "idle-c@example.test", name: null }, role: "member" });
      let token = await signSession({ userId, accountId: "acc" }, shortEnv, { epoch: 0, now: () => start });

      // Refresh every 30 minutes -- comfortably inside the 1h idle
      // window each time -- for 90 minutes total, still under the 2h
      // absolute limit.
      let t = start;
      for (let i = 0; i < 3; i++) {
        t += 30 * 60 * 1000;
        const res = await shellSessionHandler(reqTo("/api/preferences", { token }), d, {
          env: shortEnv,
          now: () => t,
        });
        expect(res.status).toBe(200);
        token = refreshedToken(res);
      }

      // One more activity step, still well inside the (freshly slid) 1h
      // idle window, but now past the 2h absolute limit anchored to the
      // ORIGINAL sign-in -- continuous activity cannot push this out.
      t += 45 * 60 * 1000; // start + 135min, past the 120min absolute limit
      const res = await shellSessionHandler(reqTo("/api/preferences", { token }), d, {
        env: shortEnv,
        now: () => t,
      });
      expect(res.status).toBe(401);
    });
  });
});

describe("unrecognized shellPath (also covers a client hitting /api/shell/session directly, bypassing the rewrite)", () => {
  it("a request that reaches the module without a mapped shellPath -> 404", async () => {
    const res = await shellSessionHandler(
      new NextRequest("https://example.test/api/shell/session"),
      deps(),
    );
    expect(res.status).toBe(404);
  });

  it("a spoofed x-fx-shell-path naming an unmapped value -> 404 (the header alone doesn't grant access to an arbitrary shape)", async () => {
    const res = await shellSessionHandler(
      new NextRequest("https://example.test/api/shell/session", {
        headers: { [SHELL_PATH_HEADER]: "/api/something-else" },
      }),
      deps(),
    );
    expect(res.status).toBe(404);
  });
});
