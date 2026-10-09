import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  type RunnerCloneBudget,
  createRunnerGitTicketKeys,
  InstallationTokenCache,
  signRunnerGitTicket,
  type AccessTokenRequester,
  type RunnerGitResolution,
} from "@fx/github";
import { captureReports } from "../../../../test/captureReports";
import { captureRealGitBodies, type RealGitBodies } from "../../../../../../packages/github/test/helpers/realGitBodies.js";
import { ghProxyHandler, MAX_RUNNER_GIT_BODY, UpstreamTimeoutError, type GhProxyHandlerDeps, type PinnedRequestParams, type PinnedResponse } from "./handler";
import { loadRunnerTicketEnv } from "./proxyEnv";

/**
 * D#6 R5a-2c: the runner path of the gh-proxy handler (C27 section 2.1). The ticket is real (EdDSA, signed with `signRunnerGitTicket`), the
 * request bodies are the real installed git's, and the last block drives a real git clone and push through the real handler.
 */

const run = promisify(execFile);
const CONFIG_HOST = "gh-proxy.fulcrumaxe.app";
const AUD = `https://${CONFIG_HOST}/api/gh-proxy`;
const ISSUER = "https://cloud.example.test";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const RUN = "0b1c2d3e-0000-4000-8000-000000000001";
const BRANCH = `fx/${RUN}-g2`;
const OPTION_BRANCH = `fx/${RUN}-g3`;
const MINTED = ["ghs", "_", "r".repeat(36)].join("");
const IDS = { runner: "00000000-0000-4000-8000-0000000000a1", account: "00000000-0000-4000-8000-0000000000a2", repo: "00000000-0000-4000-8000-0000000000a3" };

let bodies: RealGitBodies;
let privateKey: KeyObject;
let keys: NonNullable<ReturnType<typeof createRunnerGitTicketKeys>>;
let appPem: string;

beforeAll(async () => {
  bodies = await captureRealGitBodies(BRANCH, OPTION_BRANCH);
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  keys = createRunnerGitTicketKeys({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "k1" }] })!;
  appPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    .privateKey as unknown as string;
}, 120_000);
afterAll(async () => {
  await bodies?.close();
});

async function ticketFor(over: { audience?: string; ref?: string; repo?: { id: string; owner: string; name: string }; at?: number } = {}): Promise<string> {
  const { ticket } = await signRunnerGitTicket(
    {
      issuer: ISSUER,
      audience: over.audience ?? AUD,
      runnerId: IDS.runner,
      accountId: IDS.account,
      runId: RUN,
      leaseGeneration: 2,
      repo: over.repo ?? { id: IDS.repo, owner: "acme", name: "widgets" },
      ref: over.ref ?? BRANCH,
    },
    { keyId: "k1", privateKey },
    new Date(over.at ?? NOW),
  );
  return ticket;
}

/** A stand-in for the database counter with the same contract: spent once the day's bytes reach the limit. */
function memoryBudget(limit: number): RunnerCloneBudget & { total: () => number } {
  let bytes = 0;
  return {
    isSpent: async () => bytes >= limit,
    record: async (_repo, n) => {
      bytes += n;
      return bytes >= limit;
    },
    total: () => bytes,
  };
}

const grant: RunnerGitResolution = { verdict: "ok", role: "executor", product: "team", installationId: 9, appKind: "team", owner: "acme", repo: "widgets" };

interface Harness {
  deps: GhProxyHandlerDeps;
  forwarded: PinnedRequestParams[];
  resolve: ReturnType<typeof vi.fn>;
  requester: ReturnType<typeof vi.fn<AccessTokenRequester>>;
  budget: ReturnType<typeof memoryBudget>;
  /** The promises the handler gave to `defer` (the platform's waitUntil), in order. */
  deferred: Promise<unknown>[];
}
function harness(over: { resolution?: RunnerGitResolution | null; upstream?: (p: PinnedRequestParams) => PinnedResponse | Promise<PinnedResponse>; budgetBytes?: number; configured?: boolean } = {}): Harness {
  const forwarded: PinnedRequestParams[] = [];
  const budget = memoryBudget(over.budgetBytes ?? 1_000_000);
  const deferred: Promise<unknown>[] = [];
  const resolve = vi.fn(async () => (over.resolution === undefined ? grant : over.resolution));
  const requester = vi.fn<AccessTokenRequester>(async () => ({ token: MINTED, expiresAt: new Date(NOW + 3600_000).toISOString() }));
  const upstream = over.upstream ?? (() => ({ status: 200, headers: { "content-type": "application/x-git-upload-pack-result" }, bodyStream: new Response("upstream-bytes").body }));
  const deps: GhProxyHandlerDeps = {
    githubForward: { host: CONFIG_HOST, suffix: "fulcrumaxe.app" } as GhProxyHandlerDeps["githubForward"],
    coldStartCheck: Promise.resolve({ ok: true }),
    oidcJwks: (() => {
      throw new Error("the runner path never uses the OIDC key set");
    }) as unknown as GhProxyHandlerDeps["oidcJwks"],
    oidcIssuer: "https://oidc.vercel.com/test-team",
    oidcTeamId: "team_1",
    oidcProjectId: "prj_1",
    resolveUpstream: vi.fn(async () => ["140.82.112.3"]),
    forwardPinned: vi.fn(async (p: PinnedRequestParams) => {
      forwarded.push(p);
      return upstream(p);
    }),
    resolveSandboxRun: vi.fn(async () => null),
    appCredentials: () => ({ appId: "app-1", privateKeyPem: appPem, webhookSecret: "unused" }),
    tokenCache: new InstallationTokenCache(),
    accessTokenRequester: requester,
    now: () => NOW,
    ...(over.configured === false
      ? {}
      : { runnerTicket: { keys, issuer: ISSUER }, resolveRunnerGit: resolve, cloneBudget: budget, defer: (work: Promise<unknown>) => void deferred.push(work) }),
  };
  return { deps, forwarded, resolve, requester, budget, deferred };
}

function req(opts: { path: string; method?: string; ticket?: string | null; oidc?: string | null; body?: Uint8Array; encoding?: string; host?: string; query?: string; headers?: Record<string, string> }): NextRequest {
  const headers = new Headers({ host: opts.host ?? CONFIG_HOST, ...opts.headers });
  if (opts.ticket) headers.set("fx-git-ticket", opts.ticket);
  if (opts.ticket === "") headers.set("fx-git-ticket", "");
  if (opts.oidc !== undefined && opts.oidc !== null) headers.set("vercel-sandbox-oidc-token", opts.oidc);
  if (opts.encoding) headers.set("content-encoding", opts.encoding);
  return new NextRequest(`https://example.test/api/gh-proxy${opts.path}${opts.query ?? ""}`, { method: opts.method ?? "POST", headers, ...(opts.body ? { body: opts.body } : {}) });
}
const UPLOAD = "/acme/widgets.git/git-upload-pack";
const RECEIVE = "/acme/widgets.git/git-receive-pack";

/** Everything a response shows a caller: status, headers and body. */
async function shown(res: Response): Promise<string> {
  return `${res.status}\n${JSON.stringify([...res.headers.entries()])}\n${await res.text()}`;
}

describe("C27 section 2.1: the order of checks", () => {
  it("host binding and the cold-start check come before the ticket is even looked at", async () => {
    const h = harness();
    expect((await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), host: "attacker.example", body: bodies.lsRefs }), h.deps)).status).toBe(421);
    h.deps.coldStartCheck = Promise.resolve({ ok: false });
    expect((await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.lsRefs }), h.deps)).status).toBe(503);
    expect(h.forwarded).toEqual([]);
  });

  it("both credentials at once: 401 ambiguous_credentials, whatever the ticket is", async () => {
    const reports = captureReports();
    const h = harness();
    for (const ticket of [await ticketFor(), "garbage"]) {
      const res = await ghProxyHandler(req({ path: UPLOAD, ticket, oidc: "x", body: bodies.lsRefs }), h.deps);
      expect([res.status, await res.json()]).toEqual([401, { error: "ambiguous_credentials" }]);
    }
    expect(reports.classes.map((c) => c.code)).toEqual(["ambiguous_credentials", "ambiguous_credentials"]);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("a request with no ticket takes the sandbox path, unchanged, whether or not the ticket settings exist", async () => {
    for (const configured of [true, false]) {
      const h = harness({ configured });
      const res = await ghProxyHandler(req({ path: "/repos/acme/widgets/issues/5", method: "GET" }), h.deps);
      expect([res.status, await res.json()]).toEqual([401, { error: "missing_oidc_token" }]);
    }
  });

  it("with the ticket settings unset or invalid the runner path answers 503 and logs on every request, while the sandbox path still works", async () => {
    const reports = captureReports();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unset = harness({ configured: false });
      const problem = harness();
      problem.deps.runnerTicket = { problem: "FX_GIT_TICKET_PUBLIC_JWKS" };
      for (const h of [unset, problem, unset]) {
        const res = await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.lsRefs }), h.deps);
        expect([res.status, await res.json()]).toEqual([503, { error: "runner_path_not_configured" }]);
      }
      expect(error).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(error.mock.calls)).toContain("FX_GIT_TICKET_PUBLIC_JWKS");
      expect(reports.classes.map((c) => c.code)).toEqual(Array(3).fill("runner_path_not_configured"));
      // A request with an OIDC token and no ticket is still the sandbox path's: it fails there on its own terms, not with the runner's 503.
      const sandbox = await ghProxyHandler(req({ path: "/repos/acme/widgets/issues/5", method: "GET", oidc: "token" }), unset.deps);
      expect([sandbox.status, await sandbox.json()]).toEqual([401, { error: "oidc_signature" }]);
    } finally {
      error.mockRestore();
    }
  });

  it("a bad ticket is 401 before the body is judged: a 5 MB body with a bad ticket is 401, with a good one 413", async () => {
    const h = harness();
    const big = new Uint8Array(5_000_000);
    const bad = await ghProxyHandler(req({ path: UPLOAD, ticket: "not-a-jwt", body: big }), h.deps);
    expect([bad.status, await bad.json()]).toEqual([401, { error: "ticket_invalid" }]);
    for (const ticket of [await ticketFor({ audience: "https://other.example/api/gh-proxy" }), await ticketFor({ at: NOW - 3600_000 })]) {
      expect((await ghProxyHandler(req({ path: UPLOAD, ticket, body: big }), h.deps)).status).toBe(401);
    }
    const good = await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: big }), h.deps);
    expect([good.status, await good.json()]).toEqual([413, { error: "push_too_large" }]);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.requester).not.toHaveBeenCalled();
  });

  it("an empty ticket header is a ticket (and invalid), not a missing one", async () => {
    const res = await ghProxyHandler(req({ path: UPLOAD, ticket: "", body: bodies.lsRefs }), harness().deps);
    expect([res.status, await res.json()]).toEqual([401, { error: "ticket_invalid" }]);
  });

  it("the lease is resolved with the ticket's own run, generation and repo, never a URL part, on EVERY request", async () => {
    const h = harness();
    const ticket = await ticketFor();
    for (const body of [bodies.lsRefs, bodies.lsRefs]) await ghProxyHandler(req({ path: UPLOAD, ticket, body }), h.deps);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.resolve).toHaveBeenCalledWith({ runnerId: IDS.runner, accountId: IDS.account, runId: RUN, generation: 2, repoId: IDS.repo, fullClone: false });
  });
});

describe("C27 section 3.3: the verdicts", () => {
  const table: Array<[string, RunnerGitResolution | null, number, string]> = [
    ["stale", { verdict: "stale" }, 409, "lease_stale"],
    ["not_running", { verdict: "not_running" }, 409, "lease_ended"],
    ["expired", { verdict: "expired" }, 409, "lease_ended"],
    ["revoked", { verdict: "revoked" }, 401, "runner_revoked"],
    ["clone_limited", { verdict: "clone_limited" }, 429, "clone_limited"],
    ["unknown", { verdict: "unknown" }, 403, "denied"],
    ["not_verified", { verdict: "not_verified" }, 403, "denied"],
    ["no_repo", { verdict: "no_repo" }, 403, "denied"],
    ["installation_ambiguous", { verdict: "installation_ambiguous" }, 403, "denied"],
    ["a database error", null, 403, "denied"],
  ];
  it.each(table)("%s", async (_name, resolution, status, error) => {
    const reports = captureReports();
    const h = harness({ resolution });
    const res = await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.fullClone }), h.deps);
    expect([res.status, await res.json()]).toEqual([status, { error }]);
    if (status === 429) expect(res.headers.get("retry-after")).toBe(String(12 * 3600));
    expect(h.forwarded).toEqual([]);
    expect(h.requester).not.toHaveBeenCalled();
    expect(reports.classes).toHaveLength(1);
    expect(reports.classes[0]!.code).not.toBe("other");
  });
});

describe("what reaches GitHub, and what a caller sees", () => {
  it("forwards a push of at most 4 MiB byte-identical, with push options unchanged, and the ticket never reaches the upstream", async () => {
    const h = harness({ upstream: () => ({ status: 200, headers: { "content-type": "application/x-git-receive-pack-result" }, bodyStream: new Response("ok").body }) });
    const ticket = await ticketFor();
    // The real push, then the same push padded to exactly 4 MiB (the pack bytes follow the commands, which is all the proxy reads).
    const padded = new Uint8Array(MAX_RUNNER_GIT_BODY);
    padded.set(bodies.push.body);
    for (const body of [bodies.push.body, padded]) {
      const res = await ghProxyHandler(req({ path: RECEIVE, ticket, body, headers: { "git-protocol": "version=2", "x-forwarded-for": "1.2.3.4", cookie: "a=b" } }), h.deps);
      expect(res.status).toBe(200);
    }
    expect(h.forwarded).toHaveLength(2);
    expect(Buffer.from(h.forwarded[0]!.body!).equals(Buffer.from(bodies.push.body))).toBe(true);
    expect(h.forwarded[1]!.body!.byteLength).toBe(MAX_RUNNER_GIT_BODY);
    for (const f of h.forwarded) {
      expect(Object.keys(f.headers)).not.toContain("fx-git-ticket");
      expect(JSON.stringify(f.headers)).not.toContain(ticket);
      expect(f.headers["git-protocol"]).toBe("version=2");
      expect(Object.keys(f.headers)).not.toContain("cookie");
      expect(f.headers["authorization"]).toBe(`Basic ${Buffer.from(`x-access-token:${MINTED}`).toString("base64")}`);
      expect([f.host, f.method, f.path]).toEqual(["github.com", "POST", RECEIVE]);
    }
    const option = harness();
    const withOption = await ghProxyHandler(req({ path: RECEIVE, ticket: await ticketFor({ ref: OPTION_BRANCH }), body: bodies.pushWithOption.body }), option.deps);
    expect(withOption.status).toBe(200);
    expect(Buffer.from(option.forwarded[0]!.body!).equals(Buffer.from(bodies.pushWithOption.body))).toBe(true);
  });

  it("a body of 4 MiB + 1 is 413 push_too_large, before the lease is asked", async () => {
    const reports = captureReports();
    const h = harness();
    const body = new Uint8Array(MAX_RUNNER_GIT_BODY + 1);
    body.set(bodies.push.body);
    const res = await ghProxyHandler(req({ path: RECEIVE, ticket: await ticketFor(), body }), h.deps);
    expect([res.status, await res.json()]).toEqual([413, { error: "push_too_large" }]);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(reports.classes.map((c) => c.code)).toEqual(["push_too_large"]);
  });

  it("denies push-cert, a delete, a second ref and the wrong ref, each as the generic 403 and with nothing forwarded", async () => {
    const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    const zero = "0".repeat(40);
    const sha = "a".repeat(40);
    const build = (...lines: string[]) => new TextEncoder().encode(lines.map(pkt).join("") + "0000");
    const h = harness();
    const ticket = await ticketFor();
    for (const body of [
      build(`push-cert\0report-status\n`, "certificate version 0.1\n", "\n", `${zero} ${sha} refs/heads/${BRANCH}\n`, "-----BEGIN PGP SIGNATURE-----\n"),
      build(`${sha} ${zero} refs/heads/${BRANCH}\0report-status\n`),
      build(`${zero} ${sha} refs/heads/${BRANCH}\0report-status\n`, `${zero} ${sha} refs/heads/${BRANCH}-x\n`),
      bodies.pushWithOption.body,
    ]) {
      const res = await ghProxyHandler(req({ path: RECEIVE, ticket, body }), h.deps);
      expect([res.status, await res.json()]).toEqual([403, { error: "denied" }]);
    }
    expect(h.forwarded).toEqual([]);
    expect(h.requester).not.toHaveBeenCalled();
  });

  it("refuses every REST call and every other encoding, and passes a gzip upload-pack body on with its header", async () => {
    const h = harness();
    const ticket = await ticketFor();
    const rest = await ghProxyHandler(req({ path: "/repos/acme/widgets/issues/5/labels", ticket, body: new TextEncoder().encode('{"labels":["x"]}') }), h.deps);
    expect([rest.status, await rest.json()]).toEqual([403, { error: "denied" }]);
    const br = await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone, encoding: "br" }), h.deps);
    expect(br.status).toBe(403);
    expect(h.forwarded).toEqual([]);
    const gz = await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullCloneGzip.raw, encoding: "gzip" }), h.deps);
    expect(gz.status).toBe(200);
    expect(h.forwarded[0]!.headers["content-encoding"]).toBe("gzip");
    expect(Buffer.from(h.forwarded[0]!.body!).equals(Buffer.from(bodies.fullCloneGzip.raw))).toBe(true);
    expect(h.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ fullClone: true }));
  });

  it("no response, on any path, contains an installation token (`ghs_`), including the answer to a request the upstream refused", async () => {
    const h = harness({ upstream: () => ({ status: 403, headers: { "content-type": "text/plain" }, bodyStream: new Response("remote: Permission denied").body }) });
    const ticket = await ticketFor();
    const seen: string[] = [];
    for (const r of [
      req({ path: UPLOAD, ticket, body: bodies.fullClone }),
      req({ path: RECEIVE, ticket, body: bodies.push.body }),
      req({ path: "/acme/widgets.git/info/refs", method: "GET", ticket, query: "?service=git-receive-pack" }),
      req({ path: UPLOAD, ticket: "bad", body: bodies.fullClone }),
      req({ path: UPLOAD, ticket, oidc: "x" }),
      req({ path: "/repos/acme/widgets/pulls", ticket, body: new Uint8Array(0) }),
    ]) {
      seen.push(await shown(await ghProxyHandler(r, h.deps)));
    }
    const failing = harness();
    failing.requester.mockRejectedValue(new Error(`mint failed ${MINTED}`));
    seen.push(await shown(await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone }), failing.deps)));
    const unconfigured = harness({ configured: false });
    seen.push(await shown(await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone }), unconfigured.deps)));
    expect(seen).toHaveLength(8);
    for (const text of seen) expect(text).not.toContain("ghs_");
    // The token did go upstream, as the proxy's own Authorization, and only there.
    expect(h.forwarded.length).toBeGreaterThan(0);
  });

  it("answers an unresolvable upstream with 502 and a header timeout with 504, each reported by its own code", async () => {
    const reports = captureReports();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dns = harness();
      (dns.deps.resolveUpstream as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("dns"));
      expect((await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.lsRefs }), dns.deps)).status).toBe(502);
      const slow = harness({
        upstream: () => {
          throw new UpstreamTimeoutError("headers");
        },
      });
      expect((await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.lsRefs }), slow.deps)).status).toBe(504);
      expect(reports.classes.map((c) => c.code)).toEqual(expect.arrayContaining(["runner_upstream_unavailable", "runner_upstream_timeout"]));
    } finally {
      warn.mockRestore();
    }
  });

  it("meters the upload-pack response while it streams, then refuses the repository's next clone with 429 and Retry-After", async () => {
    const reports = captureReports();
    const chunks = [new Uint8Array(400), new Uint8Array(400), new Uint8Array(400)];
    const h = harness({
      budgetBytes: 1000,
      upstream: () => ({
        status: 200,
        headers: {},
        bodyStream: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
          },
        }),
      }),
    });
    const ticket = await ticketFor();
    const first = await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone }), h.deps);
    expect((await first.arrayBuffer()).byteLength).toBe(1200);
    const second = await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone }), h.deps);
    expect(h.budget.total()).toBe(1200);
    expect([second.status, await second.json()]).toEqual([429, { error: "clone_limited" }]);
    expect(second.headers.get("retry-after")).toBe(String(12 * 3600));
    expect(reports.classes.at(-1)!.code).toBe("clone_bytes_limited");
    // Discovery and a push are not metered.
    expect((await ghProxyHandler(req({ path: "/acme/widgets.git/info/refs", method: "GET", ticket, query: "?service=git-upload-pack" }), h.deps)).status).toBe(200);
    expect((await ghProxyHandler(req({ path: RECEIVE, ticket, body: bodies.push.body }), h.deps)).status).toBe(200);
  });

  it("counts the bytes already sent when the runner cuts a response off", async () => {
    const h = harness({
      budgetBytes: 1000,
      upstream: () => ({
        status: 200,
        headers: {},
        bodyStream: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(400));
            controller.close();
          },
        }),
      }),
    });
    const res = await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.fullClone }), h.deps);
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(h.budget.total()).toBeGreaterThanOrEqual(first.value!.byteLength);
    expect(h.budget.total()).toBeGreaterThan(0);
  });

  it("sends a response that crosses the 32 MiB checkpoint only while the count says the repository is still under its allowance", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const h = harness({
      budgetBytes: 40 * 1024 * 1024,
      upstream: () => ({
        status: 200,
        headers: {},
        bodyStream: new ReadableStream<Uint8Array>({
          // A finite pack of 100 MiB: the handler's byte counter reads the whole upstream body, so an endless one would never stop.
          start(controller) {
            for (let i = 0; i < 100; i++) controller.enqueue(chunk);
            controller.close();
          },
        }),
      }),
    });
    const res = await ghProxyHandler(req({ path: UPLOAD, ticket: await ticketFor(), body: bodies.fullClone }), h.deps);
    const reader = res.body!.getReader();
    let sent = 0;
    let failure: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent += value.byteLength;
      }
    } catch (err) {
      failure = err;
    }
    // Checkpoints at 32 MiB (open: 32 < 40) and 64 MiB (spent: 64 >= 40). The chunk that reaches the second one is counted but not sent.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("clone_bytes_limited");
    expect(sent).toBe(63 * 1024 * 1024);
    expect(h.budget.total()).toBe(64 * 1024 * 1024);
    expect(h.deferred).toHaveLength(0);
  });

  it("hands the final add of a short response to defer, and a runner path with no defer answers 503", async () => {
    const h = harness({ budgetBytes: 1000, upstream: () => ({ status: 200, headers: {}, bodyStream: new Response(new Uint8Array(400)).body }) });
    const ticket = await ticketFor();
    const res = await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone }), h.deps);
    expect((await res.arrayBuffer()).byteLength).toBe(400);
    expect(h.deferred).toHaveLength(1);
    await Promise.all(h.deferred);
    expect(h.budget.total()).toBe(400);
    const withoutDefer = { ...h.deps };
    delete withoutDefer.defer;
    const refused = await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone }), withoutDefer);
    expect(refused.status).toBe(503);
  });

  it("reports every refusal by a closed code on the telemetry allowlist, never `other`", async () => {
    const reports = captureReports();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ticket = await ticketFor();
      const h = harness();
      await ghProxyHandler(req({ path: "/acme/other.git/git-upload-pack", ticket, body: bodies.lsRefs }), h.deps);
      await ghProxyHandler(req({ path: "/repos/acme/widgets/issues", ticket, method: "GET" }), h.deps);
      await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone, encoding: "br" }), h.deps);
      await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.fullClone, encoding: "gzip" }), h.deps);
      await ghProxyHandler(req({ path: UPLOAD, ticket, body: new TextEncoder().encode("junk") }), h.deps);
      await ghProxyHandler(req({ path: "/acme/widgets.git/info/refs", method: "GET", ticket, query: "?service=git-upload-pack&service=git-upload-pack" }), h.deps);
      await ghProxyHandler(req({ path: RECEIVE, ticket, body: bodies.pushWithOption.body }), h.deps);
      await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.lsRefs }), { ...h.deps, resolveRunnerGit: async () => ({ ...grant, repo: "renamed" }) as RunnerGitResolution });
      const failing = harness();
      failing.requester.mockRejectedValue(new Error("x"));
      await ghProxyHandler(req({ path: UPLOAD, ticket, body: bodies.lsRefs }), failing.deps);
      expect(reports.classes.map((c) => c.code)).toEqual([
        "runner_repo_mismatch",
        "runner_path_refused",
        "runner_content_encoding",
        "runner_inflate_refused",
        "runner_upload_pack_unparsable",
        "runner_query_refused",
        "runner_policy_denied",
        "runner_repo_mismatch",
        "runner_mint_failed",
      ]);
      expect(reports.everything()).not.toContain(ticket);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the runner path's settings", () => {
  it("names the setting that is wrong, never its value, and accepts a good pair", () => {
    const jwks = JSON.stringify({ keys: [] });
    expect(loadRunnerTicketEnv({ FX_GIT_TICKET_ISSUER: ISSUER, FX_GIT_TICKET_PUBLIC_JWKS: jwks })).toEqual({ ok: true, jwks: { keys: [] }, issuer: ISSUER });
    for (const issuer of [undefined, "", "not a url", `${ISSUER}/path`, `${ISSUER}/`]) {
      expect(loadRunnerTicketEnv({ FX_GIT_TICKET_ISSUER: issuer, FX_GIT_TICKET_PUBLIC_JWKS: jwks })).toEqual({ ok: false, problem: "FX_GIT_TICKET_ISSUER" });
    }
    for (const bad of [undefined, "", "{not json"]) {
      expect(loadRunnerTicketEnv({ FX_GIT_TICKET_ISSUER: ISSUER, FX_GIT_TICKET_PUBLIC_JWKS: bad })).toEqual({ ok: false, problem: "FX_GIT_TICKET_PUBLIC_JWKS" });
    }
  });
});

describe("real git, through the real handler", () => {
  let root: string;
  let source: string;
  let target: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  const seen: Array<{ method: string; path: string; headers: Record<string, string>; bodyBytes: number }> = [];
  const env = (): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  });
  const git = async (args: string[], cwd = root) => (await run("git", args, { cwd, env: env() })).stdout;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fx-runner-path-"));
    source = join(root, "source.git");
    target = join(root, "target.git");
    const work = join(root, "work");
    await git(["init", "-q", "-b", "main", work]);
    for (let i = 0; i < 30; i++) {
      if (i > 0) await git(["checkout", "-q", "-B", `topic-${i}`, "main"], work);
      await git(["commit", "-q", "--allow-empty", "-m", `c${i}`], work);
    }
    await git(["init", "--bare", "-q", "-b", "main", source]);
    await git(["init", "--bare", "-q", "-b", "main", target]);
    await git(["push", "-q", source, "--all"], work);

    // The "upstream": git's own server side, reached through the handler's pinned forward.
    const upstream = (p: PinnedRequestParams): PinnedResponse => {
      seen.push({ method: p.method, path: p.path, headers: p.headers, bodyBytes: p.body?.byteLength ?? 0 });
      const url = new URL(p.path, "https://github.com");
      const service = url.pathname.endsWith("receive-pack") || url.searchParams.get("service") === "git-receive-pack" ? "receive-pack" : "upload-pack";
      const dir = service === "receive-pack" ? target : source;
      const protocol = p.headers["git-protocol"] ?? "";
      const e = { ...env(), GIT_PROTOCOL: protocol };
      const isDiscovery = url.pathname.endsWith("/info/refs");
      const child = spawn("git", [service, "--stateless-rpc", ...(isDiscovery ? ["--advertise-refs"] : []), dir], { env: e });
      // GitHub inflates a gzip request body itself; this stand-in does the same.
      if (!isDiscovery && p.body) child.stdin.end(p.headers["content-encoding"] === "gzip" ? gunzipSync(p.body) : Buffer.from(p.body));
      const prefix = isDiscovery && !protocol.includes("version=2") ? `001f# service=git-${service}\n0000` : "";
      const out = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const stream = prefix
        ? new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(prefix));
              const reader = out.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            },
          })
        : out;
      return { status: 200, headers: { "content-type": `application/x-git-${service}-${isDiscovery ? "advertisement" : "result"}` }, bodyStream: stream };
    };
    const h = harness({ upstream, budgetBytes: 10_000_000 });
    server = createServer((incoming, res) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (c: Buffer) => chunks.push(c));
      incoming.on("end", () => {
        void (async () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(incoming.headers)) if (typeof v === "string" && k !== "host") headers.set(k, v);
          headers.set("host", CONFIG_HOST);
          const body = Buffer.concat(chunks);
          const out = await ghProxyHandler(
            new NextRequest(`https://example.test${incoming.url ?? "/"}`, { method: incoming.method ?? "GET", headers, ...(body.byteLength ? { body } : {}) }),
            h.deps,
          );
          res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
          const reader = out.body?.getReader();
          for (;;) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) break;
            res.write(chunk.value);
          }
          res.end();
        })();
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/gh-proxy/acme/widgets.git`;
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((ok) => server?.close(() => ok()));
    rmSync(root, { recursive: true, force: true });
  });

  it("clones every branch (v2, gzip request body), with the ticket on every request and never upstream", async () => {
    const ticket = await ticketFor();
    const dest = join(root, "clone");
    await git(["-c", `http.extraHeader=fx-git-ticket: ${ticket}`, "-c", "credential.helper=!echo FAIL >&2; false", "clone", "-q", base, dest]);
    const branches = (await git(["branch", "-r"], dest)).split("\n").filter(Boolean);
    expect(branches.length).toBeGreaterThanOrEqual(30);
    expect(seen.some((s) => s.method === "POST" && s.path.endsWith("git-upload-pack") && s.headers["content-encoding"] === "gzip")).toBe(true);
    for (const s of seen) {
      expect(Object.keys(s.headers)).not.toContain("fx-git-ticket");
      expect(JSON.stringify(s.headers)).not.toContain(ticket);
    }
  }, 60_000);

  it("pushes the ticket's branch, and git is refused when it pushes any other", async () => {
    const dest = join(root, "clone");
    const ticket = await ticketFor();
    await git(["commit", "-q", "--allow-empty", "-m", "mine"], dest);
    const header = ["-c", `http.extraHeader=fx-git-ticket: ${ticket}`];
    await git([...header, "push", "-q", base, `HEAD:refs/heads/${BRANCH}`], dest);
    expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${BRANCH}`], target)).trim()).toBe(`refs/heads/${BRANCH}`);
    await expect(git([...header, "push", "-q", base, "HEAD:refs/heads/main"], dest)).rejects.toThrow(/403/);
    await expect(git([...header, "push", "-q", base, `HEAD:refs/heads/${BRANCH}`, "HEAD:refs/heads/other"], dest)).rejects.toThrow();
    expect((await git(["for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/heads/other"], target)).trim()).toBe("");
  }, 60_000);
});
