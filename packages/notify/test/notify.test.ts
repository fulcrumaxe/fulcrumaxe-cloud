import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newResendWorld, startStrictResend, type StrictResend } from "./helpers/strictResend.js";
import { loadNotifyConfig } from "../src/config.js";
import { codeForStatus, createResendTransport, type EmailMessage } from "../src/resend.js";
import { buildEmailText } from "../src/template.js";

const KEY = "re_test_key_fixed";
const MSG: EmailMessage = { from: "Fulcrumaxe <ask@verified.example>", to: ["owner@example.test"], subject: "A decision is waiting for you", text: "hello" };

describe("loadNotifyConfig", () => {
  const base = { RESEND_API_KEY: KEY, NOTIFY_FROM: "ask@verified.example", FX_APP_ORIGIN: "https://app.example/" };
  it("is on only with the key, the sender and the origin, and strips a trailing slash", () => {
    expect(loadNotifyConfig(base)).toEqual({ ok: true, apiKey: KEY, from: "ask@verified.example", appOrigin: "https://app.example" });
  });
  it("names the first missing setting by a fixed reason; blank counts as missing", () => {
    expect(loadNotifyConfig({ ...base, RESEND_API_KEY: undefined })).toEqual({ ok: false, reason: "no_resend_key" });
    expect(loadNotifyConfig({ ...base, RESEND_API_KEY: "  " })).toEqual({ ok: false, reason: "no_resend_key" });
    expect(loadNotifyConfig({ ...base, NOTIFY_FROM: undefined })).toEqual({ ok: false, reason: "no_from_address" });
    expect(loadNotifyConfig({ ...base, FX_APP_ORIGIN: undefined })).toEqual({ ok: false, reason: "no_app_origin" });
  });
});

describe("buildEmailText", () => {
  it("is fixed copy, counts and the app link, and nothing else", () => {
    const one = buildEmailText({ appOrigin: "https://app.example", first: 1, reminder: 0 });
    expect(one.subject).toBe("A decision is waiting for you");
    expect(one.text).toContain("Open Needs you to answer: https://app.example");
    const many = buildEmailText({ appOrigin: "https://app.example", first: 2, reminder: 1 });
    expect(many.subject).toBe("3 decisions are waiting for you");
    expect(many.text).toContain("2 decisions are waiting for your answer.");
    expect(many.text).toContain("1 decision is overdue.");
    expect(buildEmailText({ appOrigin: "https://app.example", first: 0, reminder: 2 }).subject).toBe("Reminder: a decision is overdue");
    for (const t of [one, many]) expect(`${t.subject}\n${t.text}`).not.toMatch(/undefined|null/);
  });
});

describe("codeForStatus", () => {
  it("maps 2xx to success, 429 and 5xx to retryable codes, 401/403 to auth and other 4xx to rejected", () => {
    expect([200, 202, 429, 500, 503, 401, 403, 400, 422].map(codeForStatus)).toEqual([null, null, "rate_limited", "server_error", "server_error", "auth", "auth", "rejected", "rejected"]);
  });
});

describe("the Resend transport against the strict fake (real TLS, no mail leaves the machine)", () => {
  let fake: StrictResend;
  const transport = (apiKey = KEY, timeoutMs?: number) =>
    createResendTransport({ apiKey, ...(timeoutMs ? { timeoutMs } : {}), testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
  beforeEach(async () => {
    fake = await startStrictResend(newResendWorld([KEY], ["verified.example"]));
  });
  afterEach(async () => {
    await fake.close();
  });

  it("sends with the bearer key, a User-Agent and a JSON body, verifying the certificate for api.resend.com", async () => {
    expect(await transport().send(MSG)).toEqual({ ok: true });
    expect(fake.world.sent).toEqual([{ from: MSG.from, to: MSG.to, subject: MSG.subject, text: "hello" }]);
    const seen = fake.requests[0]!;
    expect(seen.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(seen.headers["user-agent"]).toBeTruthy();
    expect(seen.headers["content-type"]).toBe("application/json");
  });
  it("an unknown key is the fixed code auth; an unverified sending domain is auth too; a malformed recipient is rejected", async () => {
    expect(await transport("re_wrong").send(MSG)).toEqual({ ok: false, code: "auth" });
    expect(await transport().send({ ...MSG, from: "ask@unverified.example" })).toEqual({ ok: false, code: "auth" });
    expect(await transport().send({ ...MSG, to: ["not-an-address"] })).toEqual({ ok: false, code: "rejected" });
    expect(fake.world.sent).toEqual([]);
  });
  it("429 and 5xx are the fixed retryable codes, then the next send is accepted", async () => {
    fake.world.failNext.push(429, 503);
    expect(await transport().send(MSG)).toEqual({ ok: false, code: "rate_limited" });
    expect(await transport().send(MSG)).toEqual({ ok: false, code: "server_error" });
    expect(await transport().send(MSG)).toEqual({ ok: true });
  });
  it("a certificate that does not match is refused (network), not accepted", async () => {
    const other = await startStrictResend(newResendWorld([KEY], ["verified.example"]));
    try {
      const t = createResendTransport({ apiKey: KEY, testTarget: { lookup: fake.lookup, port: fake.port, ca: other.ca } });
      expect(await t.send(MSG)).toEqual({ ok: false, code: "network" });
    } finally {
      await other.close();
    }
  });
  it("a receiver that never answers ends at the timeout with the fixed code", async () => {
    fake.world.gate = new Promise<void>(() => undefined);
    expect(await transport(KEY, 300).send(MSG)).toEqual({ ok: false, code: "timeout" });
  });
  it("refuses the test target outside NODE_ENV=test", async () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(await transport().send(MSG)).toEqual({ ok: false, code: "blocked" });
      expect(fake.requests).toEqual([]);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

describe("where the Resend address and key are read (criterion 8)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === "dist" || name === ".git") continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
    }
    return out;
  };
  it("only packages/notify/src names the Resend host or reads RESEND_API_KEY (tests, the fake and the settings manifests aside)", () => {
    const hits = [...walk(path.join(root, "packages")), ...walk(path.join(root, "apps"))]
      .filter((f) => !/[\\/](test|tests|e2e)[\\/]|\.test\.|env-manifest|strictResend/.test(f))
      .filter((f) => /api\.resend\.com|process\.env\.RESEND_API_KEY|env\.RESEND_API_KEY/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(hits.every((f) => f.startsWith("packages/notify/src/")), hits.join(",")).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });
});
