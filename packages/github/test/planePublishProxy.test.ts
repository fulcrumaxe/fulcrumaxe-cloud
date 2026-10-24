import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as ghPolicy from "@fx/gh-policy";
import { PLANE_PUBLISH_DENY_REASONS } from "@fx/gh-policy";
import {
  decideProxyRequest,
  InstallationTokenCache,
  MintTimeoutError,
  PlanePushApiError,
  createPlanePushApi,
  type AccessTokenRequester,
  type ProxyDecisionDeps,
  type ProxyDecisionInput,
  type PublishTarget,
  type ResolvedSandboxRun,
} from "../src/index.js";
import { captureRealGitBodies, type RealGitBodies } from "./helpers/realGitBodies.js";

/**
 * D#598 P1f-4b: the proxy's `plane_publish` rule set, through the real decideProxyRequest and the real mint code. The publish target is the
 * database's answer (faked here as the resolver the real one is tested against in publishTargetResolver.pg.test.ts); the public repository's mint
 * is a spy standing in for planePushApi (covered in planePushApi.test.ts). The push body is the REAL installed git's push of the recorded branch.
 *
 * `decide` is wrapped so a test can see whether it ran: the publish rule set must replace it for that role, and an executor must still reach it.
 */
vi.mock("@fx/gh-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/gh-policy")>();
  return { ...actual, decide: vi.fn(actual.decide) };
});

const BRANCH = "fx/p-0b1c2d3e-0000-4000-8000-000000000001";
const TARGET: PublishTarget = { codeRepo: "acme-public/widgets-pub", branch: BRANCH };
const PRIVATE_RUN: ResolvedSandboxRun = { role: "plane_publish", product: "team", installationId: 99, appKind: "team", owner: "acme", repo: "widgets" };
const EXECUTOR_RUN: ResolvedSandboxRun = { ...PRIVATE_RUN, role: "executor" };
const SANDBOX = "pp-0b1c2d3e-0000-4000-8000-0000000000aa";
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const PUSH_TOKEN = ["ghs", "_", "p".repeat(36)].join(""); // gitleaks:allow
const READ_TOKEN = ["ghs", "_", "r".repeat(36)].join(""); // gitleaks:allow

let bodies: RealGitBodies;
let otherBranchBodies: RealGitBodies;
let privateKeyPem: string;
beforeAll(async () => {
  bodies = await captureRealGitBodies(BRANCH, "fx/p-other");
  otherBranchBodies = await captureRealGitBodies("fx/p-0b1c2d3e-0000-4000-8000-0000000000ff", "fx/p-other2");
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    .privateKey as unknown as string;
}, 180_000);
afterAll(async () => {
  await bodies?.close();
  await otherBranchBodies?.close();
});
beforeEach(() => {
  vi.mocked(ghPolicy.decide).mockClear();
});

interface Harness {
  deps: ProxyDecisionDeps;
  resolvePublishTarget: ReturnType<typeof vi.fn>;
  mintPushToken: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
  requester: ReturnType<typeof vi.fn>;
}

function harness(run: ResolvedSandboxRun | null, target: PublishTarget | null = TARGET): Harness {
  const resolvePublishTarget = vi.fn(async () => target);
  const mintPushToken = vi.fn(async () => PUSH_TOKEN);
  const revokeToken = vi.fn(async () => true);
  const requester = vi.fn<AccessTokenRequester>(async (p) => ({
    token: READ_TOKEN,
    expiresAt: new Date(NOW + 3600_000).toISOString(),
    permissions: { metadata: "read", contents: "read" },
    repositories: p.repositories ?? [],
  }));
  return {
    resolvePublishTarget,
    mintPushToken,
    revokeToken,
    requester,
    deps: {
      resolveSandboxRun: vi.fn(async () => run),
      resolvePublishTarget,
      planePublishApi: { mintPushToken, revokeToken },
      appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
      tokenCache: new InstallationTokenCache(),
      accessTokenRequester: requester,
      now: () => NOW,
    },
  };
}

const input = (method: string, path: string, over: Partial<ProxyDecisionInput> = {}): ProxyDecisionInput => ({
  method,
  path,
  query: {},
  rawBody: new Uint8Array(0),
  sandboxName: SANDBOX,
  ...over,
});
const discovery = (repo: string, service = "git-upload-pack") => input("GET", `/${repo}/info/refs`, { query: { service } });
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const mints = (h: Harness) => h.mintPushToken.mock.calls.length + h.requester.mock.calls.length;

describe("an executor-role run still cannot name the paired public repository (22)", () => {
  const publicRequests = (): Array<[string, ProxyDecisionInput]> => [
    ["git discovery", discovery("acme-public/widgets-pub", "git-receive-pack")],
    ["a git push", input("POST", "/acme-public/widgets-pub/git-receive-pack", { rawBody: new Uint8Array(bodies.push.body) })],
    ["an API read", input("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`)],
    ["a pull request", input("POST", "/repos/acme-public/widgets-pub/pulls", { rawBody: json({ title: "t", head: BRANCH, base: "main" }) })],
  ];

  it.each([0, 1, 2, 3])("request %i: 403 repo_out_of_scope from decide(), no mint, with a pairing row", async (i) => {
    const h = harness(EXECUTOR_RUN);
    const r = await decideProxyRequest(publicRequests()[i]![1], h.deps);
    expect(r).toEqual({ allow: false, status: 403, reason: "repo_out_of_scope" });
    expect(mints(h)).toBe(0);
    expect(ghPolicy.decide).toHaveBeenCalledTimes(1);
  });

  it("holds with no pairing row at all: the publish target is never even asked for", async () => {
    const h = harness(EXECUTOR_RUN, null);
    for (const [, request] of publicRequests()) {
      const r = await decideProxyRequest(request, h.deps);
      expect(r).toEqual({ allow: false, status: 403, reason: "repo_out_of_scope" });
    }
    expect(h.resolvePublishTarget).not.toHaveBeenCalled();
    expect(mints(h)).toBe(0);
  });

  it("an executor still gets its own repository, through decide(), with the ordinary cached token (no revoke)", async () => {
    const h = writeHarness();
    const r = await decideProxyRequest(input("GET", "/repos/acme/widgets/issues/5"), h.deps);
    expect(r).toMatchObject({ allow: true, installationToken: "ghs_exec" });
    expect(r).not.toHaveProperty("revokeAfterUse");
    expect(ghPolicy.decide).toHaveBeenCalledTimes(1);
    expect(h.resolvePublishTarget).not.toHaveBeenCalled();
  });
});

function writeHarness(): Harness {
  const h = harness(EXECUTOR_RUN);
  h.requester.mockImplementation(async () => ({ token: "ghs_exec", expiresAt: new Date(NOW + 3600_000).toISOString() }));
  return h;
}

describe("a publish run with no resolved target is denied before any mint (24a)", () => {
  it("no row: publish_target_not_resolved for every request, no mint of either kind", async () => {
    const h = harness(PRIVATE_RUN, null);
    for (const request of [discovery("acme/widgets"), discovery("acme-public/widgets-pub"), input("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`)]) {
      expect(await decideProxyRequest(request, h.deps)).toEqual({ allow: false, status: 403, reason: "publish_target_not_resolved" });
    }
    expect(h.resolvePublishTarget).toHaveBeenCalledWith(SANDBOX);
    expect(mints(h)).toBe(0);
  });

  it("a proxy wired without the resolver or the API fails closed with its own fixed reason", async () => {
    const h = harness(PRIVATE_RUN);
    const noResolver: ProxyDecisionDeps = { ...h.deps, resolvePublishTarget: undefined };
    expect(await decideProxyRequest(discovery("acme/widgets"), noResolver)).toEqual({ allow: false, status: 403, reason: "publish_not_configured" });
    const noApi: ProxyDecisionDeps = { ...h.deps, planePublishApi: undefined };
    expect(await decideProxyRequest(discovery("acme/widgets"), noApi)).toEqual({ allow: false, status: 403, reason: "publish_not_configured" });
    expect(mints(h)).toBe(0);
  });
});

describe("the publish rule set runs instead of decide() (24b)", () => {
  it("never calls decide() for the role, allowed or denied, and every reason is a fixed string", async () => {
    const h = harness(PRIVATE_RUN);
    const requests: ProxyDecisionInput[] = [
      discovery("acme/widgets"),
      discovery("acme-public/widgets-pub", "git-receive-pack"),
      input("GET", "/repos/acme/widgets/issues/5"),
      input("PUT", "/repos/acme-public/widgets-pub/contents/x"),
      input("GET", "/gists"),
      input("POST", "/acme-public/widgets-pub/git-receive-pack"),
    ];
    const reasons: string[] = [];
    for (const r of requests) {
      const d = await decideProxyRequest(r, h.deps);
      if (!d.allow) reasons.push(d.reason);
    }
    expect(ghPolicy.decide).not.toHaveBeenCalled();
    expect(reasons.length).toBeGreaterThan(0);
    const fixed = new Set<string>([...PLANE_PUBLISH_DENY_REASONS, "publish_target_not_resolved", "publish_not_configured", "path_not_recognized"]);
    for (const reason of reasons) expect(fixed.has(reason)).toBe(true);
  });
});

describe("the recorded repository is compared exactly (24c)", () => {
  it.each([
    ["a different case of the owner", "Acme-Public/widgets-pub"],
    ["a different case of the name", "acme-public/Widgets-Pub"],
    ["an added suffix", "acme-public/widgets-pub2"],
    ["another owner", "evil/widgets-pub"],
    ["the private repo's name under the public owner", "acme-public/widgets"],
  ])("%s is denied, with no mint", async (_n, repo) => {
    const h = harness(PRIVATE_RUN);
    expect(await decideProxyRequest(discovery(repo), h.deps)).toEqual({ allow: false, status: 403, reason: "publish_repo_out_of_scope" });
    expect(await decideProxyRequest(input("GET", `/repos/${repo}/git/ref/heads/${BRANCH}`), h.deps)).toEqual({ allow: false, status: 403, reason: "publish_repo_out_of_scope" });
    expect(mints(h)).toBe(0);
  });
});

describe("what a publish run is allowed, and which token each request gets (23)", () => {
  it("a private-repo read mints a fresh read-only token for the private repository alone, and asks to be revoked", async () => {
    const h = harness(PRIVATE_RUN);
    const a = await decideProxyRequest(discovery("acme/widgets"), h.deps);
    const b = await decideProxyRequest(input("POST", "/acme/widgets/git-upload-pack"), h.deps);
    expect(a).toMatchObject({ allow: true, upstreamHost: "github.com", installationToken: READ_TOKEN, revokeAfterUse: true, forwardContentEncoding: false });
    expect(b).toMatchObject({ allow: true, installationToken: READ_TOKEN, revokeAfterUse: true });
    // Two requests, two mints: nothing is cached or shared between them.
    expect(h.requester).toHaveBeenCalledTimes(2);
    expect(h.requester).toHaveBeenCalledWith(expect.objectContaining({ installationId: 99, repositories: ["widgets"], permissions: { metadata: "read", contents: "read" } }));
    expect(h.mintPushToken).not.toHaveBeenCalled();
  });

  it("a public-repo request gets a push token minted for the recorded repository, and asks to be revoked", async () => {
    const h = harness(PRIVATE_RUN);
    const reqs = [
      discovery("acme-public/widgets-pub", "git-receive-pack"),
      input("POST", "/acme-public/widgets-pub/git-upload-pack"),
      input("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`),
      input("POST", "/repos/acme-public/widgets-pub/pulls", { rawBody: json({ title: "t", head: BRANCH, base: "main", body: "b", maintainer_can_modify: false }) }),
      input("POST", "/acme-public/widgets-pub/git-receive-pack", { rawBody: new Uint8Array(bodies.push.body) }),
    ];
    for (const r of reqs) {
      expect(await decideProxyRequest(r, h.deps)).toMatchObject({ allow: true, installationToken: PUSH_TOKEN, revokeAfterUse: true });
    }
    expect(h.mintPushToken).toHaveBeenCalledTimes(reqs.length);
    expect(h.mintPushToken).toHaveBeenCalledWith("acme-public/widgets-pub", { ownsInstallation: expect.any(Function) });
    // The public repo's installation counts as owned only when it is the run's own team-App installation (99 in this harness).
    const own = h.mintPushToken.mock.calls[0]![1] as { ownsInstallation: (id: number) => Promise<boolean> };
    await expect(own.ownsInstallation(99)).resolves.toBe(true);
    await expect(own.ownsInstallation(7)).resolves.toBe(false);
    expect(h.requester).not.toHaveBeenCalled();
  });

  describe("with the real planePushApi, whose installation lookup names an installation by id", () => {
    // A GitHub that answers the lookup like the real one: an App JWT bearer and a User-Agent are required, the answer is the installation of the repository.
    const lookupFetch = (installationId: number) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const h = init?.headers as Record<string, string>;
        if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(h.authorization ?? "") || h["user-agent"] !== "fulcrumaxe-cloud") return new Response("{}", { status: 401 });
        return new URL(String(url)).pathname === "/repos/acme-public/widgets-pub/installation" ? new Response(JSON.stringify({ id: installationId }), { status: 200 }) : new Response("{}", { status: 404 });
      }) as typeof fetch;
    const withRealApi = (installationId: number) => {
      const h = harness(PRIVATE_RUN);
      const api = createPlanePushApi({ appCredentials: h.deps.appCredentials, requester: h.requester, cache: new InstallationTokenCache(), fetchImpl: lookupFetch(installationId) });
      return { h, deps: { ...h.deps, planePublishApi: { mintPushToken: api.mintPushToken, revokeToken: api.revokeToken } } };
    };

    it("an installation of another account on the public repo is refused and no token is minted", async () => {
      const { h, deps } = withRealApi(7);
      expect(await decideProxyRequest(discovery("acme-public/widgets-pub"), deps)).toEqual({ allow: false, status: 403, reason: "token_mint_failed" });
      expect(h.requester).not.toHaveBeenCalled();
    });

    it("the run's own installation on the public repo mints", async () => {
      const { h, deps } = withRealApi(99);
      h.requester.mockImplementation(async (p) => ({ token: PUSH_TOKEN, expiresAt: new Date(NOW + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] }));
      expect(await decideProxyRequest(discovery("acme-public/widgets-pub"), deps)).toMatchObject({ allow: true, installationToken: PUSH_TOKEN });
      expect(h.requester).toHaveBeenCalledWith(expect.objectContaining({ installationId: 99, repositories: ["widgets-pub"] }));
    });
  });

  it("the API requests go to api.github.com and the git requests to github.com", async () => {
    const h = harness(PRIVATE_RUN);
    expect(await decideProxyRequest(input("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`), h.deps)).toMatchObject({ upstreamHost: "api.github.com" });
    expect(await decideProxyRequest(discovery("acme-public/widgets-pub"), h.deps)).toMatchObject({ upstreamHost: "github.com" });
  });

  const refused: Array<[string, () => ProxyDecisionInput]> = [
    ["a real push of a different branch", () => input("POST", "/acme-public/widgets-pub/git-receive-pack", { rawBody: new Uint8Array(otherBranchBodies.push.body) })],
    ["a real push of the recorded branch to the private repository", () => input("POST", "/acme/widgets/git-receive-pack", { rawBody: new Uint8Array(bodies.push.body) })],
    ["a real push with a push option, to another branch", () => input("POST", "/acme-public/widgets-pub/git-receive-pack", { rawBody: new Uint8Array(bodies.pushWithOption.body) })],
    ["a pull request from another head", () => input("POST", "/repos/acme-public/widgets-pub/pulls", { rawBody: json({ title: "t", head: "fx/p-other", base: "main" }) })],
    ["a pull request onto another base", () => input("POST", "/repos/acme-public/widgets-pub/pulls", { rawBody: json({ title: "t", head: BRANCH, base: "release" }) })],
    ["a pull request body that repeats the head", () => input("POST", "/repos/acme-public/widgets-pub/pulls", { rawBody: new TextEncoder().encode(`{"title":"t","head":"fx/p-other","head":"${BRANCH}","base":"main"}`) })],
    ["a pull request body that is not JSON", () => input("POST", "/repos/acme-public/widgets-pub/pulls", { rawBody: new TextEncoder().encode("head=x") })],
    ["a merge", () => input("PUT", "/repos/acme-public/widgets-pub/pulls/3/merge")],
    ["any other API path", () => input("GET", "/repos/acme-public/widgets-pub/contents/README.md")],
    ["an API read of the private repository", () => input("GET", "/repos/acme/widgets/issues")],
    ["a query smuggling a repository", () => input("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`, { query: { repository: "x" } })],
    ["a repeated query key", () => input("GET", "/acme/widgets/info/refs", { query: [["service", "git-upload-pack"], ["service", "git-receive-pack"]] })],
    ["a gzip body on a push", () => input("POST", "/acme-public/widgets-pub/git-receive-pack", { rawBody: new Uint8Array(bodies.push.body), contentEncoding: "gzip" })],
  ];
  it.each(refused)("refuses %s with no mint", async (_n, build) => {
    const h = harness(PRIVATE_RUN);
    const r = await decideProxyRequest(build(), h.deps);
    expect(r).toMatchObject({ allow: false, status: 403 });
    expect(mints(h)).toBe(0);
  });
});

describe("a failed mint is a denial, with a fixed reason and nothing from the error", () => {
  it("a public mint that GitHub refuses (app not installed, scope mismatch) is token_mint_failed", async () => {
    for (const code of ["app_not_installed", "token_scope_mismatch", "pr_failed"] as const) {
      const h = harness(PRIVATE_RUN);
      h.mintPushToken.mockRejectedValue(new PlanePushApiError(code));
      expect(await decideProxyRequest(discovery("acme-public/widgets-pub"), h.deps)).toEqual({ allow: false, status: 403, reason: "token_mint_failed" });
    }
  });
  it("a public mint that cannot reach GitHub is a 502, like a mint timeout on the private side", async () => {
    const h = harness(PRIVATE_RUN);
    h.mintPushToken.mockRejectedValue(new PlanePushApiError("public_unavailable"));
    expect(await decideProxyRequest(discovery("acme-public/widgets-pub"), h.deps)).toEqual({ allow: false, status: 502, reason: "upstream_unavailable" });
    h.requester.mockRejectedValue(new MintTimeoutError());
    expect(await decideProxyRequest(discovery("acme/widgets"), h.deps)).toEqual({ allow: false, status: 502, reason: "upstream_unavailable" });
  });
  it("a private mint whose answer is not read-only is refused", async () => {
    const h = harness(PRIVATE_RUN);
    h.requester.mockResolvedValue({ token: READ_TOKEN, expiresAt: new Date(NOW + 3600_000).toISOString(), permissions: { metadata: "read", contents: "write" }, repositories: ["widgets"] });
    expect(await decideProxyRequest(discovery("acme/widgets"), h.deps)).toEqual({ allow: false, status: 403, reason: "token_mint_failed" });
  });
  it("a private repository on an App kind that is neither the write nor the read App is refused before a credential is read", async () => {
    const h = harness({ ...PRIVATE_RUN, appKind: "sitekit" });
    expect(await decideProxyRequest(discovery("acme/widgets"), h.deps)).toEqual({ allow: false, status: 403, reason: "token_mint_failed" });
    expect(h.requester).not.toHaveBeenCalled();
  });
});
