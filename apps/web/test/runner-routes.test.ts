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
    const allowed = ["packages/runner-cloud/src/hello.ts", "packages/runner-cloud/src/index.ts", "packages/runner-cloud/src/register.ts", "packages/runner-cloud/src/revoke.ts", "packages/runner-cloud/src/rotate.ts", "packages/runner-cloud/src/verifyRunnerRequest.ts", "packages/runner-protocol/src/httpSignature.ts"];
    expect(filesWith(/withRunnerSession|verifyRunnerRequest|verifySelfSignedRequest/)).toEqual(allowed);
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
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
  });
});

describe("the runner routes' edge", () => {
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => ({
    appUserPool: { query: () => Promise.reject(new Error("no query expected")) } as never,
    platformOpsPool: { query: () => Promise.reject(new Error("no query expected")), connect: () => Promise.reject(new Error("no connect expected")) } as never,
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
