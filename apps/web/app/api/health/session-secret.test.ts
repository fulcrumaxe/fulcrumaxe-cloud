import { describe, expect, it } from "vitest";
import { completeEnv } from "../../../test/support/envFixtures";
import { healthResponse } from "./handler";

/**
 * H7b through /api/health: the stable-id secret is required on a deployed
 * environment, and the session secret rotation window is judged as a trio.
 */
const OPERATOR = "operator-secret-0123456789-abcdefghij";
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const PREVIOUS = "p".repeat(40);
const AT = { FX_SESSION_SECRET_ROTATED_AT: iso(NOW) };
type Env = Record<string, string | undefined>;

async function detail(env: Env) {
  const res = healthResponse({ ...env, CRON_SECRET: OPERATOR }, `Bearer ${OPERATOR}`, NOW);
  return { status: res.status, body: (await res.json()) as { ok: boolean; missing: string[]; invalid: { name: string; reason: string }[] } };
}

describe("health: stable-id secret (H7b)", () => {
  it("is green with the secret set, on staging and production", async () => {
    for (const kind of ["staging", "production"] as const) {
      const env = completeEnv(kind);
      expect(env.FX_STABLE_ID_SECRET, kind).toBeDefined();
      expect((await detail(env)).status, kind).toBe(200);
    }
  });

  it("reports it missing (503) when unset or blank on staging and production, and not on local", async () => {
    for (const kind of ["staging", "production"] as const) {
      for (const value of [undefined, "", "   "]) {
        const env: Env = completeEnv(kind);
        if (value === undefined) delete env.FX_STABLE_ID_SECRET;
        else env.FX_STABLE_ID_SECRET = value;
        const res = await detail(env);
        expect(res.status, `${kind} ${JSON.stringify(value)}`).toBe(503);
        expect(res.body.missing).toEqual(["FX_STABLE_ID_SECRET"]);
      }
    }
    expect((await detail({})).status).toBe(200);
  });

  it("reports a stable-id secret under 32 characters as invalid, by reason only", async () => {
    const short = "s".repeat(31);
    const res = await detail({ ...completeEnv("production"), FX_STABLE_ID_SECRET: short });
    expect(res.status).toBe(503);
    expect(res.body.invalid).toEqual([{ name: "FX_STABLE_ID_SECRET", reason: "shorter_than_32_chars" }]);
    expect(JSON.stringify(res.body)).not.toContain(short);
  });
});

describe("health: session secret rotation window (H7b)", () => {
  const base = () => completeEnv("production");

  it("is green with none set, and with a trio inside the bound", async () => {
    expect((await detail(base())).status).toBe(200);
    expect((await detail({ ...base(), ...AT, FX_SESSION_SECRET_PREVIOUS: PREVIOUS, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW + 10 * DAY) })).status).toBe(200);
  });

  it("is an error when one of the pair is set without the other", async () => {
    expect(await detail({ ...base(), ...AT, FX_SESSION_SECRET_PREVIOUS: PREVIOUS })).toMatchObject({
      status: 503,
      body: { invalid: [{ name: "FX_SESSION_SECRET_PREVIOUS", reason: "set_without_until" }] },
    });
    expect(await detail({ ...base(), ...AT, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW + DAY) })).toMatchObject({
      status: 503,
      body: { invalid: [{ name: "FX_SESSION_SECRET_PREVIOUS_UNTIL", reason: "set_without_previous_secret" }] },
    });
  });

  it("is an error when ROTATED_AT is missing from the trio, or set alone", async () => {
    const pair = { FX_SESSION_SECRET_PREVIOUS: PREVIOUS, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW + DAY) };
    expect(await detail({ ...base(), ...pair })).toMatchObject({ status: 503, body: { invalid: [{ name: "FX_SESSION_SECRET_ROTATED_AT", reason: "set_without_rotated_at" }] } });
    expect(await detail({ ...base(), ...AT })).toMatchObject({ status: 503, body: { invalid: [{ name: "FX_SESSION_SECRET_ROTATED_AT", reason: "set_without_previous_pair" }] } });
  });

  it("is an error when ROTATED_AT is later than now", async () => {
    const trio = { FX_SESSION_SECRET_PREVIOUS: PREVIOUS, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW + DAY), FX_SESSION_SECRET_ROTATED_AT: iso(NOW + 1000) };
    expect(await detail({ ...base(), ...trio })).toMatchObject({ status: 503, body: { invalid: [{ name: "FX_SESSION_SECRET_ROTATED_AT", reason: "in_the_future" }] } });
  });

  it("is an error when UNTIL is past ROTATED_AT plus the session lifetime, and honours FX_SESSION_ABSOLUTE_SECONDS", async () => {
    const pair = { ...AT, FX_SESSION_SECRET_PREVIOUS: PREVIOUS, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW + 31 * DAY) };
    expect(await detail({ ...base(), ...pair })).toMatchObject({ status: 503, body: { invalid: [{ name: "FX_SESSION_SECRET_PREVIOUS_UNTIL", reason: "beyond_session_lifetime" }] } });
    expect((await detail({ ...base(), ...pair, FX_SESSION_ABSOLUTE_SECONDS: String(31 * 24 * 3600) })).status).toBe(200);
  });

  it("is an error once UNTIL has passed and the previous secret is still set (removal is asked for)", async () => {
    const res = await detail({ ...base(), FX_SESSION_SECRET_ROTATED_AT: iso(NOW - 2000), FX_SESSION_SECRET_PREVIOUS: PREVIOUS, FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW - 1000) });
    expect(res).toMatchObject({ status: 503, body: { invalid: [{ name: "FX_SESSION_SECRET_PREVIOUS", reason: "expired_remove_it" }] } });
  });

  it("wrong value: a previous secret under 32 characters or an UNTIL that is not a timestamp fails the self-check", async () => {
    const shortSecret = await detail({ ...base(), ...AT, FX_SESSION_SECRET_PREVIOUS: "q".repeat(10), FX_SESSION_SECRET_PREVIOUS_UNTIL: iso(NOW + DAY) });
    expect(shortSecret.status).toBe(503);
    expect(shortSecret.body.invalid).toEqual([{ name: "FX_SESSION_SECRET_PREVIOUS", reason: "shorter_than_32_chars" }]);
    const badUntil = await detail({ ...base(), ...AT, FX_SESSION_SECRET_PREVIOUS: PREVIOUS, FX_SESSION_SECRET_PREVIOUS_UNTIL: "next week" });
    expect(badUntil.status).toBe(503);
    expect(badUntil.body.invalid).toEqual([{ name: "FX_SESSION_SECRET_PREVIOUS_UNTIL", reason: "not_an_iso_timestamp" }]);
  });

  it("gives an anonymous caller only the verdict, and no value reaches anyone", async () => {
    const env = { ...base(), FX_SESSION_SECRET_PREVIOUS: PREVIOUS };
    const anonymous = healthResponse(env, null, NOW);
    expect(anonymous.status).toBe(503);
    const text = JSON.stringify(await anonymous.json());
    expect(text).not.toContain("FX_SESSION_SECRET_PREVIOUS");
    expect(text).not.toContain(PREVIOUS);
    expect(JSON.stringify((await detail(env)).body)).not.toContain(PREVIOUS);
  });
});
