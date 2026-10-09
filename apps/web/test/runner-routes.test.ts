import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "node:crypto";
import { jwkThumbprint, signRequest, type Ed25519Jwk } from "@fulcrumaxe/runner-protocol";
import { MAX_BODY_BYTES, type RunnerCloudDeps } from "@fx/runner-cloud";
import { handleRunnerRequest, readCappedBody } from "../lib/runnerRoutes";
import { mintCodeHandler } from "../app/api/runners/registration-codes/handler";
import { revokeRunnerHandler } from "../app/api/runners/[id]/revoke/handler";
import { revokeAllHandler } from "../app/api/runners/revoke-all/handler";
import { listRunnersHandler } from "../app/api/runners/handler";
import { approveRunHandler } from "../app/api/runners/runs/[id]/approve/handler";
import { executionModeHandler } from "../app/api/runners/repos/[id]/execution-mode/handler";
import { makeRegisterHandler } from "../app/api/runner/register/handler";
import { REGISTER_LIMIT_PER_IP_PER_MINUTE } from "../lib/runnerRoutes";
import type { RateLimitStore } from "@fx/api/src/ratelimit/store.js";

const WEB = path.join(__dirname, "..");
const REPO = path.join(WEB, "..", "..");
const ORIGIN = "https://runner.example.test";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry === "migrations") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
const rel = (file: string): string => path.relative(REPO, file).split(path.sep).join("/");
const isTest = (file: string): boolean => /(^|\/)test\/|\.test\.tsx?$/.test(rel(file));

/** The text of each setMemberRole / removeMember call's argument list in `source`, with comments removed. */
function membershipCalls(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([^:])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:setMemberRole|removeMember)\s*\(/g)) {
    if (text.slice(Math.max(0, m.index! - 9), m.index!).endsWith("function ")) continue;
    let depth = 1;
    let i = m.index! + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if ("([{".includes(text[i]!)) depth++;
      else if (")]}".includes(text[i]!)) depth--;
    }
    out.push(text.slice(m.index! + m[0].length, i - 1));
  }
  return out;
}

/** True when the call's last argument is an object literal with a `failRunnerLeases` property (shorthand or `key: value`). */
function namesLeaseFailer(args: string): boolean {
  const last = args.trim().replace(/,$/, "");
  const open = last.lastIndexOf("{");
  if (open < 0 || !last.endsWith("}")) return false;
  return /[{,]\s*failRunnerLeases\s*(:|,|\})/.test(last.slice(open));
}

/** A signed runner request, as a Next request, with whatever extra headers the case needs. */
function signedNext(url: string, extra: Record<string, string> = {}): NextRequest {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Ed25519Jwk;
  const body = Buffer.from("{}");
  const headers = signRequest({ method: "POST", url, body, privateKey, keyid: jwkThumbprint(jwk), nonce: "n".repeat(22), created: Math.floor(Date.now() / 1000) });
  return new NextRequest(url, { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body });
}

describe("who may set app.runner_id, and who may use the runner door (D#6 R2a, C11 section 1)", () => {
  const sources = [...walk(path.join(REPO, "packages")), ...walk(path.join(REPO, "apps"))].filter((f) => !isTest(f));
  const filesWith = (needle: RegExp): string[] => sources.filter((f) => needle.test(readFileSync(f, "utf8"))).map(rel).sort();

  it("only the runner-cloud verifier sets the session setting, so no session-cookie or API-token route ever does", () => {
    expect(filesWith(/app\.runner_id/)).toEqual(["packages/runner-cloud/src/verifyRunnerRequest.ts"]);
  });

  it("only runner-cloud's own code opens a runner session or verifies a runner request", () => {
    const allowed = ["packages/runner-cloud/src/claim.ts", "packages/runner-cloud/src/done.ts", "packages/runner-cloud/src/gitTicket.ts", "packages/runner-cloud/src/heartbeat.ts", "packages/runner-cloud/src/hello.ts", "packages/runner-cloud/src/index.ts", "packages/runner-cloud/src/ingestEvents.ts", "packages/runner-cloud/src/register.ts", "packages/runner-cloud/src/revoke.ts", "packages/runner-cloud/src/rotate.ts", "packages/runner-cloud/src/verifyRunnerRequest.ts", "packages/runner-protocol/src/httpSignature.ts"];
    expect(filesWith(/withRunnerSession|verifyRunnerRequest|verifySelfSignedRequest/)).toEqual(allowed);
  });

  it("every call of setMemberRole or removeMember names failRunnerLeases in its own options object (R2a follow-up 7, checked per call site)", () => {
    const callers = sources.filter((f) => !/packages\/core\/src\/tenancy\/membership\.ts$/.test(rel(f)) && /\b(setMemberRole|removeMember)\s*\(/.test(readFileSync(f, "utf8")));
    // No membership route exists yet. When one is added every call must pass the lease failer, and this test is what makes it.
    for (const file of callers) {
      for (const call of membershipCalls(readFileSync(file, "utf8"))) expect(namesLeaseFailer(call), `${rel(file)}: ${call.slice(0, 120)}`).toBe(true);
    }
    // The type enforces the same thing: the option is required and has no default.
    const definition = readFileSync(path.join(REPO, "packages/core/src/tenancy/membership.ts"), "utf8");
    expect(definition).toMatch(/failRunnerLeases: RunnerLeaseFailer \| null;/);
    expect(definition).not.toMatch(/options: MembershipChangeOptions\s*=/);
  });

  it("the call-site scan is not fooled: a mention in a comment, a second call without it, an alias or a variable all fail", () => {
    const calls = (src: string) => membershipCalls(src).map(namesLeaseFailer);
    expect(calls("await removeMember(pool, a, b, c, { failRunnerLeases: fail });")).toEqual([true]);
    expect(calls("await removeMember(pool, a, b, c, { failRunnerLeases });")).toEqual([true]);
    expect(calls("// failRunnerLeases\nawait removeMember(pool, a, b, c, {});")).toEqual([false]);
    expect(calls("const failRunnerLeases = f;\nawait removeMember(pool, a, b, c, { failRunnerLeases: fail });\nawait setMemberRole(pool, a, b, c, 'admin', opts);")).toEqual([true, false]);
    expect(calls("await removeMember(pool, a, b, c);")).toEqual([false]);
    expect(calls("await setMemberRole(pool, a, b, c, 'admin', { fail: failRunnerLeases });")).toEqual([false]);
    expect(calls("await setMemberRole(pool, a, b, c, 'admin', opts); // { failRunnerLeases: null }")).toEqual([false]);
  });

  it("no route outside api/runner/** touches the runner door, the runner key tables or the setting", () => {
    const api = path.join(WEB, "app", "api");
    const outside = walk(api).filter((f) => !f.startsWith(path.join(api, "runner") + path.sep) && !isTest(f));
    expect(outside.length).toBeGreaterThan(5);
    for (const file of outside) {
      const text = readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/app\.runner_id|withRunnerSession|verifyRunnerRequest|verifySelfSignedRequest|handleRunnerRequest|runner_request_nonces/);
    }
  });
});

describe("a runner-signed request is not a session (every route outside api/runner/**)", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeAll(() => {
    // Pools connect lazily; none of these requests reaches a query.
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.DATABASE_URL_APP_USER = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.FX_APP_ORIGIN = ORIGIN;
  });

  it("the session routes under api/runners answer 401 to a runner signature, with or without a bearer token", async () => {
    const calls: Array<() => Promise<Response>> = [
      () => mintCodeHandler(signedNext(`${ORIGIN}/api/runners/registration-codes`)),
      () => revokeRunnerHandler(signedNext(`${ORIGIN}/api/runners/x/revoke`), "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e"),
      () => revokeAllHandler(signedNext(`${ORIGIN}/api/runners/revoke-all`)),
      () => revokeAllHandler(signedNext(`${ORIGIN}/api/runners/revoke-all`, { authorization: "Bearer fxat_notarealtoken" })),
      // D#6 R2b: the list, the approval and the execution-mode change are session routes too.
      () => listRunnersHandler(signedNext(`${ORIGIN}/api/runners`)),
      () => listRunnersHandler(signedNext(`${ORIGIN}/api/runners`, { authorization: "Bearer fxat_notarealtoken" })),
      () => approveRunHandler(signedNext(`${ORIGIN}/api/runners/runs/x/approve`), "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e"),
      () => executionModeHandler(signedNext(`${ORIGIN}/api/runners/repos/x/execution-mode`), "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e"),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
  });
});

describe("the runner routes' edge", () => {
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => ({
    appUserPool: { query: () => Promise.reject(new Error("no query expected")) } as never,
    origin: ORIGIN,
    failRunnerLeases: null,
    ...over,
  });
  const run = async () => ({ status: 200, body: { ok: true } });

  it("answers 413 to a declared or streamed body over 256 KiB without reading on", async () => {
    const declared = new NextRequest(`${ORIGIN}/api/runner/hello`, { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) }, body: "x" });
    expect((await handleRunnerRequest(declared, run, () => deps())).status).toBe(413);
    const streamed = new Request(`${ORIGIN}/api/runner/hello`, { method: "POST", body: new Blob([Buffer.alloc(MAX_BODY_BYTES + 10)]) });
    expect(await readCappedBody(streamed, MAX_BODY_BYTES)).toBeNull();
    const small = new Request(`${ORIGIN}/api/runner/hello`, { method: "POST", body: "abc" });
    expect(Buffer.from((await readCappedBody(small, MAX_BODY_BYTES))!).toString()).toBe("abc");
  });

  it("never lets an internal error's text reach the runner", async () => {
    const req = new NextRequest(`${ORIGIN}/api/runner/hello`, { method: "POST", body: "{}" });
    const res = await handleRunnerRequest(req, async () => { throw new Error("password=hunter2 at /srv/db"); }, () => deps());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });
});

describe("register is limited per client address before anything else happens (D#6 R2b, CWE-770)", () => {
  const KEYS = ["DATABASE_URL_PLATFORM_OPS", "DATABASE_URL_APP_USER", "FX_APP_ORIGIN"] as const;
  const saved = KEYS.map((key) => [key, process.env[key]] as const);
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeAll(() => {
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.DATABASE_URL_APP_USER = "postgres://unused:unused@127.0.0.1:1/unused";
    process.env.FX_APP_ORIGIN = ORIGIN;
  });

  /** A fixed-window counter with the contract of rate_limit_check: the call counts, then it is allowed while the count is within the limit; the retry hint is at least one second. */
  function fakeStore(): RateLimitStore & { keys: string[] } {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
      keys,
      checkAndIncrement: async (key, limit) => {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { allowed: n <= limit, retryAfterSeconds: 37 };
      },
    };
  }
  const from = (ip: string, body: string | Uint8Array = "not json") => new NextRequest(`${ORIGIN}/api/runner/register`, { method: "POST", headers: { "x-real-ip": ip }, body });

  it("lets the first requests of an address through to the handler, then answers 429 with Retry-After, whatever the body", async () => {
    const store = fakeStore();
    const handler = makeRegisterHandler(() => store);
    expect(REGISTER_LIMIT_PER_IP_PER_MINUTE).toBe(10); // packages/api/test/ratelimit.test.ts drives the real bucket with this literal
    for (let i = 0; i < REGISTER_LIMIT_PER_IP_PER_MINUTE; i++) expect((await handler(from("203.0.113.7"))).status, `request ${i + 1}`).toBe(400); // the handler ran and refused the body
    // The 11th is stopped before the body is read: a body over the 256 KiB cap would otherwise be a 413.
    const limited = await handler(from("203.0.113.7", Buffer.alloc(MAX_BODY_BYTES + 10)));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("37");
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" }, retry_after: 37 });
    // Another address has its own budget.
    expect((await handler(from("203.0.113.8"))).status).toBe(400);
    expect(new Set(store.keys)).toEqual(new Set(["anon:runner-register:203.0.113.7", "anon:runner-register:203.0.113.8"]));
  });

  it("buckets an IPv6 client by its /64, so rotating inside a block does not open a fresh budget", async () => {
    const store = fakeStore();
    const handler = makeRegisterHandler(() => store);
    await handler(from("2001:db8:1:2:aaaa::1"));
    await handler(from("2001:db8:1:2:bbbb::9"));
    expect(new Set(store.keys).size).toBe(1);
  });

  it("fails closed when the limiter is down: an error, never an unlimited registration", async () => {
    const down: RateLimitStore = { checkAndIncrement: () => Promise.reject(new Error("db down")) };
    const res = await makeRegisterHandler(() => down)(from("203.0.113.9"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });
});
