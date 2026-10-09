import { generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decideRunnerGitRequest,
  getInstallationToken,
  InstallationTokenCache,
  MAX_RUNNER_GIT_BODY_BYTES,
  MintTimeoutError,
  secondsUntilUtcMidnight,
  type RunnerCloneBudget,
  type AccessTokenRequester,
  type RunnerGitDecisionDeps,
  type RunnerGitDecisionInput,
  type RunnerGitResolution,
  type RunnerGitTicketClaims,
} from "../src/index.js";
import { captureRealGitBodies, type RealGitBodies } from "./helpers/realGitBodies.js";

/**
 * D#6 R5a-2c: the runner path's decision (C27 section 2.1 steps 7 to 11). The request bodies are the REAL installed git's, captured from a local
 * smart-HTTP exchange; only shapes real git cannot send (a signed push, a delete) are built by hand and say so.
 */

const RUN = "0b1c2d3e-0000-4000-8000-000000000001";
const BRANCH = `fx/${RUN}-g2`;
const OPTION_BRANCH = `fx/${RUN}-g3`;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
// Built at run time so no token-shaped literal sits in the source.
const MINTED = ["ghs", "_", "r".repeat(36)].join("");
const SANDBOX_TOKEN = ["ghs", "_", "s".repeat(36)].join("");

const ticket: RunnerGitTicketClaims = {
  issuer: "https://cloud.example.test",
  audience: "https://gh-proxy.example.test/api/gh-proxy",
  runnerId: "00000000-0000-4000-8000-0000000000a1",
  accountId: "00000000-0000-4000-8000-0000000000a2",
  runId: RUN,
  leaseGeneration: 2,
  repo: { id: "00000000-0000-4000-8000-0000000000a3", owner: "acme", name: "widgets" },
  ref: BRANCH,
  jti: "00000000-0000-4000-8000-0000000000a4",
  issuedAt: Math.floor(NOW / 1000),
  expiresAt: Math.floor(NOW / 1000) + 300,
};

const grant = (over: Partial<Extract<RunnerGitResolution, { verdict: "ok" }>> = {}): RunnerGitResolution => ({
  verdict: "ok",
  role: "executor",
  product: "team",
  installationId: 9,
  appKind: "team",
  owner: "acme",
  repo: "widgets",
  ...over,
});

let bodies: RealGitBodies;
let privateKeyPem: string;

beforeAll(async () => {
  bodies = await captureRealGitBodies(BRANCH, OPTION_BRANCH);
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    .privateKey as unknown as string;
}, 120_000);
afterAll(async () => {
  await bodies?.close();
});

function setup(resolution: RunnerGitResolution | null = grant(), spent: boolean | null = false) {
  const budget: RunnerCloneBudget = { isSpent: vi.fn(async () => spent), record: vi.fn(async () => false) };
  const resolveRunnerGit = vi.fn(async () => resolution);
  const requester = vi.fn<AccessTokenRequester>(async () => ({ token: MINTED, expiresAt: new Date(NOW + 3600_000).toISOString() }));
  const deps: RunnerGitDecisionDeps = {
    resolveRunnerGit,
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    tokenCache: new InstallationTokenCache(),
    accessTokenRequester: requester,
    cloneBudget: budget,
    now: () => NOW,
  };
  return { deps, resolveRunnerGit, requester, budget };
}

const UPLOAD = { path: "/acme/widgets.git/git-upload-pack", method: "POST", query: [] as Array<[string, string]> };
const RECEIVE = { path: "/acme/widgets.git/git-receive-pack", method: "POST", query: [] as Array<[string, string]> };
const input = (over: Partial<RunnerGitDecisionInput> & Pick<RunnerGitDecisionInput, "path" | "method" | "query">): RunnerGitDecisionInput => ({
  rawBody: new Uint8Array(0),
  contentEncoding: null,
  ticket,
  ...over,
});
const denied = (result: Awaited<ReturnType<typeof decideRunnerGitRequest>>) => {
  if (result.allow) throw new Error("expected a denial");
  return result;
};

describe("the allowed shapes, with the real git's bodies", () => {
  it("allows an ls-refs and a full clone on the read scope, and counts only the clone", async () => {
    const t = setup();
    const ls = await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), t.deps);
    expect(ls.allow).toBe(true);
    expect(t.resolveRunnerGit).toHaveBeenLastCalledWith(expect.objectContaining({ fullClone: false, generation: 2, runId: RUN, repoId: ticket.repo.id }));
    const clone = await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullClone }), t.deps);
    expect(clone).toMatchObject({ allow: true, upstreamHost: "github.com", installationToken: MINTED, forwardContentEncoding: false, meterResponse: true });
    expect(t.resolveRunnerGit).toHaveBeenLastCalledWith(expect.objectContaining({ fullClone: true }));
    expect(t.requester.mock.calls[0]![0]).toMatchObject({ installationId: 9, repositories: ["widgets"], permissions: { metadata: "read", contents: "read" } });
  });

  it("inflates a gzip upload-pack body before parsing it, and says the encoding header travels on", async () => {
    const t = setup();
    const result = await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullCloneGzip.raw, contentEncoding: "gzip" }), t.deps);
    expect(result).toMatchObject({ allow: true, forwardContentEncoding: true });
    expect(t.resolveRunnerGit).toHaveBeenLastCalledWith(expect.objectContaining({ fullClone: true }));
    // The same bytes, read as if uncompressed, are not a pkt-line stream: refused, never guessed at.
    const wrong = await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullCloneGzip.raw }), setup().deps);
    expect(denied(wrong).reason).toBe("runner_upload_pack_unparsable");
  });

  it("does not count a fetch that has `have` lines as a full clone", async () => {
    const t = setup();
    const { raw, gzipped } = bodies.fetchWithHave;
    const result = await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: raw, contentEncoding: gzipped ? "gzip" : null }), t.deps);
    expect(result.allow).toBe(true);
    expect(t.resolveRunnerGit).toHaveBeenLastCalledWith(expect.objectContaining({ fullClone: false }));
  });

  it("allows ref discovery for both services (receive-pack on the push scope, for a pushing role only)", async () => {
    const t = setup();
    const up = await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-upload-pack"]] }), t.deps);
    expect(up).toMatchObject({ allow: true, meterResponse: false, query: { service: "git-upload-pack" } });
    const rp = await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-receive-pack"]] }), t.deps);
    expect(rp.allow).toBe(true);
    expect(t.requester.mock.calls[1]![0]).toMatchObject({ permissions: { metadata: "read", contents: "write" } });
    const reviewer = setup(grant({ role: "code-reviewer" }));
    expect(denied(await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-receive-pack"]] }), reviewer.deps)).reason).toBe("runner_policy_denied");
    expect(reviewer.requester).not.toHaveBeenCalled();
  });

  it("allows the real push of exactly the ticket's branch, with a push option too, and mints a contents-write token for one repository", async () => {
    const t = setup();
    expect(await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body }), t.deps)).toMatchObject({ allow: true, meterResponse: false });
    expect(t.requester.mock.calls[0]![0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", contents: "write" } });
    // A push option rides after the commands; the second real push carries one, for the branch of a ticket that names it.
    const optionTicket = { ...ticket, ref: OPTION_BRANCH };
    expect((await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.pushWithOption.body, ticket: optionTicket }), setup().deps)).allow).toBe(true);
    expect(new TextDecoder().decode(bodies.pushWithOption.body)).toContain("ci.skip=1");
    // ...and it is not the first ticket's branch.
    expect(denied(await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.pushWithOption.body }), setup().deps)).reason).toBe("runner_policy_denied");
  });
});

describe("what is refused before the database is asked", () => {
  it("refuses every REST target, another repository, a repeated or foreign query key, and a path that is not a git target", async () => {
    const t = setup();
    const rest = await decideRunnerGitRequest(input({ path: "/repos/acme/widgets/issues/1", method: "GET", query: [] }), t.deps);
    expect(denied(rest)).toMatchObject({ status: 403, reason: "runner_path_refused" });
    const other = await decideRunnerGitRequest(input({ path: "/acme/other.git/info/refs", method: "GET", query: [["service", "git-upload-pack"]] }), t.deps);
    expect(denied(other).reason).toBe("runner_repo_mismatch");
    const dup = await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-upload-pack"], ["service", "git-receive-pack"]] }), t.deps);
    expect(denied(dup).reason).toBe("runner_query_refused");
    const foreign = await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-upload-pack"], ["repo", "x"]] }), t.deps);
    expect(denied(foreign).reason).toBe("runner_query_refused");
    const nothing = await decideRunnerGitRequest(input({ path: "/gists", method: "GET", query: [] }), t.deps);
    expect(denied(nothing).reason).toBe("runner_path_refused");
    expect(t.resolveRunnerGit).not.toHaveBeenCalled();
    expect(t.requester).not.toHaveBeenCalled();
  });

  it("accepts Content-Encoding identity or gzip only, and gzip only on a POST to git-upload-pack", async () => {
    const t = setup();
    for (const encoding of ["br", "deflate", "gzip, identity", "x-gzip", "compress", ""]) {
      expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullClone, contentEncoding: encoding }), t.deps)).reason, encoding).toBe("runner_content_encoding");
    }
    expect(denied(await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body, contentEncoding: "gzip" }), t.deps)).reason).toBe("runner_content_encoding");
    expect(denied(await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-upload-pack"]], contentEncoding: "gzip" }), t.deps)).reason).toBe("runner_content_encoding");
    expect(t.resolveRunnerGit).not.toHaveBeenCalled();
    // `identity` is the plain body: it is allowed and the header is not forwarded.
    const identity = await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullClone, contentEncoding: "Identity" }), t.deps);
    expect(identity).toMatchObject({ allow: true, forwardContentEncoding: false });
  });

  it("caps the INFLATED size: a small gzip body that inflates past 4 MiB is refused, and a body that is not gzip at all", async () => {
    const t = setup();
    const bomb = gzipSync(Buffer.alloc(MAX_RUNNER_GIT_BODY_BYTES + 1));
    expect(bomb.byteLength).toBeLessThan(10_000);
    expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bomb, contentEncoding: "gzip" }), t.deps)).reason).toBe("runner_inflate_refused");
    expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullClone, contentEncoding: "gzip" }), t.deps)).reason).toBe("runner_inflate_refused");
    expect(t.resolveRunnerGit).not.toHaveBeenCalled();
  });

  it("refuses an upload-pack body it cannot parse completely (truncated, empty), never reading it as 'not a clone'", async () => {
    const t = setup();
    for (const rawBody of [bodies.fullClone.subarray(0, bodies.fullClone.byteLength - 4), new Uint8Array(0), new TextEncoder().encode("garbage")]) {
      expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody }), t.deps)).reason).toBe("runner_upload_pack_unparsable");
    }
    expect(t.resolveRunnerGit).not.toHaveBeenCalled();
  });
});

describe("the lease verdicts (C27 section 3.3) and the checks after them", () => {
  const cases: Array<[string, RunnerGitResolution | null, number, string]> = [
    ["stale", { verdict: "stale" }, 409, "lease_stale"],
    ["not_running", { verdict: "not_running" }, 409, "lease_ended"],
    ["expired", { verdict: "expired" }, 409, "lease_ended"],
    ["revoked", { verdict: "revoked" }, 401, "runner_revoked"],
    ["unknown", { verdict: "unknown" }, 403, "runner_lease_unresolved"],
    ["not_verified", { verdict: "not_verified" }, 403, "runner_lease_unresolved"],
    ["no_repo", { verdict: "no_repo" }, 403, "runner_lease_unresolved"],
    ["installation_ambiguous", { verdict: "installation_ambiguous" }, 403, "runner_lease_unresolved"],
    ["a database error", null, 403, "runner_lease_unresolved"],
  ];
  it.each(cases)("answers %s", async (_name, resolution, status, reason) => {
    const t = setup(resolution);
    const result = denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), t.deps));
    expect(result).toMatchObject({ status, reason });
    expect(t.requester).not.toHaveBeenCalled();
  });

  it("answers clone_limited with 429 and the seconds until 00:00 UTC", async () => {
    const t = setup({ verdict: "clone_limited" });
    const result = denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.fullClone }), t.deps));
    expect(result).toMatchObject({ status: 429, reason: "clone_limited", retryAfterSeconds: 12 * 3600 });
    expect(secondsUntilUtcMidnight(NOW)).toBe(12 * 3600);
    expect(secondsUntilUtcMidnight(NOW - 1)).toBe(12 * 3600 + 1);
  });

  it("refuses when the repository was renamed since the ticket was signed, before the policy or a mint", async () => {
    const t = setup(grant({ repo: "gadgets" }));
    expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), t.deps)).reason).toBe("runner_repo_mismatch");
    expect(t.requester).not.toHaveBeenCalled();
  });

  it("applies the runner policy with the ROLE FROM THE DATABASE and the ref FROM THE TICKET", async () => {
    // A non-team product, and a role that may not push.
    expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), setup(grant({ product: "sitekit" })).deps)).reason).toBe("runner_policy_denied");
    const reviewer = setup(grant({ role: "security-reviewer" }));
    expect(denied(await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body }), reviewer.deps)).reason).toBe("runner_policy_denied");
    // The push is for the ticket's branch; a ticket naming another branch refuses the very same bytes.
    const otherRef = { ...ticket, ref: `fx/${RUN}-g3` };
    expect(denied(await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body, ticket: otherRef }), setup().deps)).reason).toBe("runner_policy_denied");
  });

  it("refuses a push it cannot read completely, a second ref, a delete of the ticket's own ref, a tag and push-cert (hand-built: real git cannot send these here)", async () => {
    const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    const zero = "0".repeat(40);
    const sha = "a".repeat(40);
    const build = (...lines: string[]) => new TextEncoder().encode(lines.map(pkt).join("") + "0000");
    const bad: Record<string, Uint8Array> = {
      truncated: bodies.push.body.subarray(0, 20),
      twoRefs: build(`${zero} ${sha} refs/heads/${BRANCH}\0report-status\n`, `${zero} ${sha} refs/heads/other\n`),
      delete: build(`${sha} ${zero} refs/heads/${BRANCH}\0report-status\n`),
      tag: build(`${zero} ${sha} refs/tags/v1\0report-status\n`),
      pushCert: build(`push-cert\0report-status\n`, "certificate version 0.1\n", "pusher x\n", "\n", `${zero} ${sha} refs/heads/${BRANCH}\n`, "-----BEGIN PGP SIGNATURE-----\n"),
    };
    for (const [name, rawBody] of Object.entries(bad)) {
      const t = setup();
      expect(denied(await decideRunnerGitRequest(input({ ...RECEIVE, rawBody }), t.deps)).reason, name).toBe("runner_policy_denied");
      expect(t.requester, name).not.toHaveBeenCalled();
    }
  });
});

describe("the daily byte budget and the mint", () => {
  it("refuses an upload-pack POST once the repository's byte allowance is spent (429, Retry-After), but never a discovery or a push", async () => {
    const t = setup(grant(), true);
    expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), t.deps))).toMatchObject({ status: 429, reason: "clone_bytes_limited", retryAfterSeconds: 12 * 3600 });
    expect(t.budget.isSpent).toHaveBeenCalledWith(ticket.repo.id);
    expect(t.requester).not.toHaveBeenCalled();
    expect((await decideRunnerGitRequest(input({ path: "/acme/widgets.git/info/refs", method: "GET", query: [["service", "git-upload-pack"]] }), t.deps)).allow).toBe(true);
    expect((await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body }), t.deps)).allow).toBe(true);
    expect(t.budget.isSpent).toHaveBeenCalledTimes(1);
  });

  it("refuses when the allowance cannot be read, before any mint (fail closed)", async () => {
    const t = setup(grant(), null);
    expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), t.deps))).toMatchObject({ status: 403, reason: "runner_lease_unresolved" });
    expect(t.requester).not.toHaveBeenCalled();
  });

  it("keeps a runner's token apart from a sandbox run's: the same role and permissions never share a cached token", async () => {
    const t = setup();
    const scope = { repositories: ["widgets"] as [string], permissions: { metadata: "read", contents: "write" } as const };
    const sandboxRequester = vi.fn<AccessTokenRequester>(async () => ({ token: SANDBOX_TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    await getInstallationToken({ installationId: 9, appKind: "team", purpose: "run", role: "executor", scope, appCredentials: t.deps.appCredentials, requester: sandboxRequester, cache: t.deps.tokenCache });
    const runner = await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body }), t.deps);
    expect(runner).toMatchObject({ allow: true, installationToken: MINTED });
    expect(t.requester).toHaveBeenCalledTimes(1);
    // And back: a second runner request reuses its own cached token, and the sandbox side still gets its own.
    await decideRunnerGitRequest(input({ ...RECEIVE, rawBody: bodies.push.body }), t.deps);
    expect(t.requester).toHaveBeenCalledTimes(1);
    const again = await getInstallationToken({ installationId: 9, appKind: "team", purpose: "run", role: "executor", scope, appCredentials: t.deps.appCredentials, requester: sandboxRequester, cache: t.deps.tokenCache });
    expect(again).toBe(SANDBOX_TOKEN);
  });

  it("refuses the runner_git purpose for a scope outside metadata and contents, for a wide scope, and for a read-only App", async () => {
    const base = { installationId: 9, role: "executor", appCredentials: setup().deps.appCredentials, requester: vi.fn<AccessTokenRequester>(), cache: new InstallationTokenCache() };
    for (const key of ["workflows", "pull_requests", "issues", "statuses", "checks"]) {
      const scope = { repositories: ["widgets"], permissions: { metadata: "read", [key]: "write" } } as unknown as Parameters<typeof getInstallationToken>[0]["scope"];
      await expect(getInstallationToken({ ...base, appKind: "team", purpose: "runner_git", scope }), key).rejects.toThrow("permission_not_allowed");
    }
    const wide = { installationWide: true, permissions: { metadata: "read" } } as unknown as Parameters<typeof getInstallationToken>[0]["scope"];
    await expect(getInstallationToken({ ...base, appKind: "team", purpose: "runner_git", scope: wide })).rejects.toThrow("purpose_not_allowed");
    const one = { repositories: ["widgets"] as [string], permissions: { metadata: "read", contents: "read" } as const };
    await expect(getInstallationToken({ ...base, appKind: "team_readonly", purpose: "runner_git", scope: one })).rejects.toThrow();
    expect(base.requester).not.toHaveBeenCalled();
  });

  it("answers 502 for a mint timeout, 403 for a read-only installation and a failed mint, and logs no secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const timeout = setup();
      timeout.requester.mockRejectedValueOnce(new MintTimeoutError());
      expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), timeout.deps))).toMatchObject({ status: 502, reason: "runner_upstream_unavailable" });
      const readOnly = setup(grant({ appKind: "team_readonly" }));
      expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), readOnly.deps))).toMatchObject({ status: 403, reason: "installation_not_writable" });
      const failing = setup();
      failing.requester.mockRejectedValueOnce(Object.assign(new Error(`boom ${MINTED}`), { status: 500 }));
      expect(denied(await decideRunnerGitRequest(input({ ...UPLOAD, rawBody: bodies.lsRefs }), failing.deps))).toMatchObject({ status: 403, reason: "runner_mint_failed" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(MINTED);
    } finally {
      warn.mockRestore();
    }
  });
});
