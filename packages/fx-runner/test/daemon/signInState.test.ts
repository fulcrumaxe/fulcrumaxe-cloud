import { describe, expect, it } from "vitest";
import { ClaimMessage, CURRENT_PROTOCOL_VERSION, VERIFY_SIGN_IN_MIN_PROTOCOL, type VerifySignInState } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { EXPIRING_SOON_MS, SERVER_SESSION_LIFETIME_MS, sidecarText, signInState } from "../../src/daemon/signInState.js";
import { generateRunnerKey } from "../../src/keys.js";

/** D#749 VERIFY-SIGNIN-EXPIRY: the runner's reckoning of its saved sign-in (pure), and what its claim carries. The files and the login command are in verifyBrowser/playwrightLocal.test.ts. */
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 15, 8);

describe("signInState", () => {
  it("counts the app's server lifetime (22 hours) from the day the sign-in was saved: ok, then expiring_soon in the last two hours, then expired", () => {
    expect(SERVER_SESSION_LIFETIME_MS).toBe(22 * H);
    expect(EXPIRING_SOON_MS).toBe(2 * H);
    const dates = { createdAtMs: T0, cookieExpiresMs: null };
    expect(signInState(T0, dates)).toBe("ok");
    expect(signInState(T0 + 19 * H, dates)).toBe("ok");
    expect(signInState(T0 + 20 * H - 1, dates)).toBe("ok");
    expect(signInState(T0 + 20 * H, dates)).toBe("ok");
    expect(signInState(T0 + 20 * H + 1, dates)).toBe("expiring_soon");
    expect(signInState(T0 + 22 * H - 1, dates)).toBe("expiring_soon");
    expect(signInState(T0 + 22 * H, dates)).toBe("expired");
    expect(signInState(T0 + 400 * H, dates)).toBe("expired");
  });

  it("uses the earlier of the cookie's own end and the server lifetime", () => {
    // The cookie ends first: three hours after saving.
    expect(signInState(T0 + 1 * H + 1, { createdAtMs: T0, cookieExpiresMs: T0 + 3 * H })).toBe("expiring_soon");
    expect(signInState(T0 + 3 * H, { createdAtMs: T0, cookieExpiresMs: T0 + 3 * H })).toBe("expired");
    // The cookie lasts weeks: the server lifetime decides.
    expect(signInState(T0 + 21 * H, { createdAtMs: T0, cookieExpiresMs: T0 + 700 * H })).toBe("expiring_soon");
    expect(signInState(T0 + 22 * H, { createdAtMs: T0, cookieExpiresMs: T0 + 700 * H })).toBe("expired");
  });

  it("the dates file holds two ISO times and nothing else", () => {
    expect(JSON.parse(sidecarText(T0, 1893456000))).toEqual({ created_at: "2026-11-15T08:00:00.000Z", cookie_expires_at: "2030-01-01T00:00:00.000Z" });
    expect(JSON.parse(sidecarText(T0, undefined))).toEqual({ created_at: "2026-11-15T08:00:00.000Z", cookie_expires_at: null });
  });
});

describe("the claim carries the state", () => {
  function claimWith(opts: { state: VerifySignInState | undefined; protocolVersion?: number }) {
    const seen: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ retry_after: 60 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn, verifySignIn: () => opts.state, ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }) });
    return { client, seen };
  }

  it("protocol 18 and later: an ordinary claim sends the word the runner reckons, beside its capacity", async () => {
    expect(VERIFY_SIGN_IN_MIN_PROTOCOL).toBe(18);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(VERIFY_SIGN_IN_MIN_PROTOCOL);
    for (const state of ["ok", "expiring_soon", "expired", "missing"] as const) {
      const { client, seen } = claimWith({ state });
      await client.claim();
      expect(seen).toEqual([{ verify_sign_in: state }]);
      expect(ClaimMessage.safeParse(seen[0]).success).toBe(true);
    }
  });

  it("sends nothing when no verify address is set, from a status poll, or from a hello that declared protocol 17: an older runner's claim is unchanged", async () => {
    const none = claimWith({ state: undefined });
    await none.client.claim();
    expect(none.seen).toEqual([{}]);
    const poll = claimWith({ state: "expired" });
    await poll.client.claim("bwrap_missing");
    expect(poll.seen).toEqual([{ sandbox_unavailable: "bwrap_missing" }]);
    const old = claimWith({ state: "expired", protocolVersion: 17 });
    await old.client.claim();
    expect(old.seen).toEqual([{}]);
  });
});
