import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GET as health } from "../app/api/health/route";
import { OPS_ENV_MANIFEST } from "../env-manifest";
import { envProblems } from "../lib/env";
import { OPS_SECRET, ORIGIN } from "./support/env";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const webNames = [...readFileSync(path.join(ROOT, "apps/web/env-manifest.ts"), "utf8").matchAll(/\bname:\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!);

/** R-68-C2-1: the one pre-existing web setting whose name starts with FX_OPS_. It is the operator error digest token, unrelated to the console. */
const WEB_EXEMPT = ["FX_OPS_DIGEST_TOKEN"];
const STAFF_CREDENTIAL = /^(DATABASE_URL_OPS|FX_OPS_)/;

describe("the two environment manifests (OPS-C2-14)", () => {
  it("reads a real manifest (sanity)", () => {
    expect(webNames.length).toBeGreaterThan(50);
    expect(webNames.some((n) => n.startsWith("DATABASE_URL_"))).toBe(true);
  });

  it("apps/web lists no staff-console setting", () => {
    expect(webNames.filter((n) => STAFF_CREDENTIAL.test(n) && !WEB_EXEMPT.includes(n))).toEqual([]);
  });

  it("the exemption is still needed: FX_OPS_DIGEST_TOKEN is in the web manifest, and drops out of this test once it is gone", () => {
    for (const name of WEB_EXEMPT) expect(webNames, name).toContain(name);
  });

  it("apps/ops lists exactly the console's settings, each with what happens while it is missing, and none of web's", () => {
    expect(OPS_ENV_MANIFEST.map((v) => v.name)).toEqual([
      "DATABASE_URL_OPS_CONSOLE",
      "FX_OPS_SESSION_SECRET",
      "FX_OPS_ORIGIN",
      "FX_OPS_ALERT_WEBHOOK_URL",
      "FX_OPS_ALERT_EMAIL",
      "CRON_SECRET",
      "RESEND_API_KEY",
      "FX_SUPPORT_FROM_ADDRESS",
      "FX_OPERATOR_ACCOUNT_IDS",
    ]);
    for (const v of OPS_ENV_MANIFEST) {
      expect(v.whenMissing, v.name).toMatch(/^(request_fails|feature_disabled|none)$/);
      expect(v.note.length, v.name).toBeGreaterThan(10);
    }
    expect(OPS_ENV_MANIFEST.filter((v) => v.required).map((v) => v.name)).toEqual(["DATABASE_URL_OPS_CONSOLE", "FX_OPS_SESSION_SECRET", "FX_OPS_ORIGIN"]);
    // (Written as a pattern so this file does not spell the names scan.test.ts forbids under apps/ops.)
    const web = /PLATFORM_OPS|APP_USER|^FX_(SESSION|KEK|WEBHOOK_KEK)|^STRIPE_/;
    expect(OPS_ENV_MANIFEST.map((v) => v.name).filter((n) => web.test(n))).toEqual([]);
    // CRON_SECRET, RESEND_API_KEY (the decision email in the web app has its own key) and FX_OPERATOR_ACCOUNT_IDS (the runtime's own list format) are the names both projects read, each with its own value.
    expect(OPS_ENV_MANIFEST.map((v) => v.name).filter((n) => webNames.includes(n))).toEqual(["CRON_SECRET", "RESEND_API_KEY", "FX_OPERATOR_ACCOUNT_IDS"]);
  });
});

describe("/api/health", () => {
  const KEYS = ["DATABASE_URL_OPS_CONSOLE", "FX_OPS_SESSION_SECRET", "FX_OPS_ORIGIN"] as const;
  const keep: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  });
  const set = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const good = { DATABASE_URL_OPS_CONSOLE: "postgres://ops_console:s3cretpw@db.example.test/app", FX_OPS_SESSION_SECRET: OPS_SECRET, FX_OPS_ORIGIN: ORIGIN };

  it("answers 200 when the required settings are present", async () => {
    set(good);
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers 503 naming each missing setting, never a value", async () => {
    for (const name of ["DATABASE_URL_OPS_CONSOLE", "FX_OPS_SESSION_SECRET", "FX_OPS_ORIGIN"]) {
      set({ ...good, [name]: undefined });
      const res = await health();
      expect(res.status, name).toBe(503);
      const text = JSON.stringify(await res.json());
      expect(JSON.parse(text).problems).toEqual([{ name, reason: "missing" }]);
      for (const secret of ["s3cretpw", OPS_SECRET]) expect(text).not.toContain(secret);
    }
    set({ ...good, DATABASE_URL_OPS_CONSOLE: " " });
    expect((await health()).status).toBe(503);
  });

  it("calls a malformed setting invalid, and still prints no value", async () => {
    set({ ...good, FX_OPS_SESSION_SECRET: "tooshort", FX_OPS_ORIGIN: `${ORIGIN}/` });
    const res = await health();
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(JSON.parse(text).problems).toEqual([
      { name: "FX_OPS_SESSION_SECRET", reason: "invalid" },
      { name: "FX_OPS_ORIGIN", reason: "invalid" },
    ]);
    expect(text).not.toContain("tooshort");
    expect(envProblems({})).toHaveLength(3);
  });
});
