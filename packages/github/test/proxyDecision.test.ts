import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  decideProxyRequest,
  MAX_PROXY_BODY_BYTES,
  type ProxyDecisionDeps,
  type ResolvedSandboxRun,
} from "../src/proxyDecision.js";
import { InstallationTokenCache, MintTimeoutError, type AccessTokenRequester } from "../src/installationToken.js";
import { loadAppCredentials } from "../src/appCredentials.js";
import { captureReports } from "./helpers/captureReports.js";

/**
 * D#2 H13b, sec-criteria B1-B7 (D#2 comment 18488780, "Part B"), and body
 * criterion 3's decide()-integration half. Every dependency here is a
 * fake -- no network, no DB, no real GitHub App key.
 */

let privateKeyPem: string;

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey as unknown as string;
});

const RUN: ResolvedSandboxRun = {
  role: "executor",
  product: "team",
  installationId: 99,
  appKind: "team",
  owner: "acme",
  repo: "widgets",
};

function deps(overrides: Partial<ProxyDecisionDeps> = {}): ProxyDecisionDeps {
  const requester: AccessTokenRequester = vi.fn(async () => ({
    token: "ghs_test",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }));
  return {
    resolveSandboxRun: vi.fn(async () => RUN),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused-in-these-tests" }),
    tokenCache: new InstallationTokenCache(),
    accessTokenRequester: requester,
    ...overrides,
  };
}

function body(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("decideProxyRequest", () => {
  it("allows a clone (git-upload-pack info/refs) and mints a token scoped to the one repo", async () => {
    const d = deps();
    const result = await decideProxyRequest(
      {
        method: "GET",
        path: "/acme/widgets.git/info/refs",
        query: { service: "git-upload-pack" },
        rawBody: body(""),
        sandboxName: "rn-8-executor-run-1",
      },
      d,
    );
    expect(result).toMatchObject({ allow: true, upstreamHost: "github.com", installationToken: "ghs_test" });
    expect(d.accessTokenRequester).toHaveBeenCalledWith(
      expect.objectContaining({ repositories: ["widgets"] }),
    );
  });

  it("allows a REST read against api.github.com", async () => {
    const d = deps();
    const result = await decideProxyRequest(
      {
        method: "GET",
        path: "/repos/acme/widgets/issues/5",
        query: {},
        rawBody: body(""),
        sandboxName: "rn-8-executor-run-1",
      },
      d,
    );
    expect(result).toMatchObject({ allow: true, upstreamHost: "api.github.com" });
  });

  it("denies path_not_recognized for a path decide() has no target shape for", async () => {
    const result = await decideProxyRequest(
      { method: "GET", path: "/gists", query: {}, rawBody: body(""), sandboxName: "x" },
      deps(),
    );
    expect(result).toMatchObject({ allow: false, status: 404, reason: "path_not_recognized" });
  });

  it("denies sandbox_not_resolved (403) when the resolver can't place the sandbox_name, and never calls decide()'s downstream token mint", async () => {
    const requester: AccessTokenRequester = vi.fn();
    const result = await decideProxyRequest(
      { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "unknown" },
      deps({ resolveSandboxRun: async () => null, accessTokenRequester: requester }),
    );
    expect(result).toMatchObject({ allow: false, status: 403, reason: "sandbox_not_resolved" });
    expect(requester).not.toHaveBeenCalled();
  });

  describe("B1: honest inputs", () => {
    it("a PATCH whose body fails to parse is denied outright, never treated as 'no fields'", async () => {
      const result = await decideProxyRequest(
        {
          method: "PATCH",
          path: "/repos/acme/widgets/issues/5",
          query: {},
          rawBody: body("{not json"),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "body_unparsable" });
    });

    it("patchFields reflects exactly the keys of the parsed body, never a caller-declared summary", async () => {
      // executor has no PATCH allowlist entry at all (PATCH_FIELD_ALLOWLIST
      // only lists project-manager:issues and executor:pulls) -- against
      // /issues/, executor's real, honestly-parsed {title} body is denied.
      const result = await decideProxyRequest(
        {
          method: "PATCH",
          path: "/repos/acme/widgets/issues/5",
          query: {},
          rawBody: body(JSON.stringify({ title: "x" })),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, reason: "issue_or_pr_patch_field_denied" });
    });
  });

  describe("B2: byte-identical path forwarding", () => {
    it("a percent-encoded path segment is denied, never decoded-and-rejudged", async () => {
      const result = await decideProxyRequest(
        { method: "GET", path: "/repos/acme/%77idgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
        deps(),
      );
      // %77 decodes to the unreserved 'w' -- gh-policy's decide() rejects
      // the ENCODED spelling outright (isCanonicalPath) rather than
      // accepting and normalizing it first and judging the normalized
      // form; this proxy passes the path through completely unmodified,
      // so decide() sees exactly this string, never a decoded one.
      expect(result).toMatchObject({ allow: false, reason: "path_not_canonical" });
    });
  });

  describe("B3: host proven at the socket", () => {
    it("a git target always resolves to github.com, an api target always to api.github.com -- computed once, never from a header", async () => {
      const git = await decideProxyRequest(
        { method: "GET", path: "/acme/widgets.git/info/refs", query: { service: "git-upload-pack" }, rawBody: body(""), sandboxName: "x" },
        deps(),
      );
      const api = await decideProxyRequest(
        { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
        deps(),
      );
      expect(git).toMatchObject({ allow: true, upstreamHost: "github.com" });
      expect(api).toMatchObject({ allow: true, upstreamHost: "api.github.com" });
    });
  });

  describe("B4: per-role single-repo tokens", () => {
    it("the minted token's scope is confined to the resolved installation's own repo, never a caller-supplied one", async () => {
      const requester: AccessTokenRequester = vi.fn(async () => ({
        token: "ghs_scoped",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }));
      await decideProxyRequest(
        { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
        deps({ accessTokenRequester: requester }),
      );
      expect(requester).toHaveBeenCalledWith(expect.objectContaining({ installationId: 99, repositories: ["widgets"] }));
    });
  });

  describe("B5: fully parsed and capped body", () => {
    it("an oversized body is denied with 413, before any decision", async () => {
      const oversized = new Uint8Array(MAX_PROXY_BODY_BYTES + 1);
      const result = await decideProxyRequest(
        { method: "POST", path: "/acme/widgets.git/git-receive-pack", query: {}, rawBody: oversized, sandboxName: "x" },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 413, reason: "body_too_large" });
    });

    it("a truncated pkt-line receive-pack body is denied, never treated as zero ref updates", async () => {
      // A well-formed 4-hex length prefix claiming more bytes than follow.
      const truncated = body("00b0not-enough-bytes");
      const result = await decideProxyRequest(
        {
          method: "POST",
          path: "/acme/widgets.git/git-receive-pack",
          query: {},
          rawBody: truncated,
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, reason: "receive_pack_unparsed_or_incomplete" });
    });
  });

  describe("B6: a fresh decision per request", () => {
    it("two calls with a resolver whose role changes between them are judged independently -- nothing is cached across requests", async () => {
      let call = 0;
      const resolveSandboxRun = vi.fn(async (): Promise<ResolvedSandboxRun> => {
        call += 1;
        // reviewer-review is denied contents write via git push; executor is allowed.
        return { ...RUN, role: call === 1 ? "executor" : "code-reviewer" };
      });
      const input = {
        method: "POST",
        path: "/acme/widgets.git/git-receive-pack",
        query: {},
        rawBody: body("0000"),
        sandboxName: "x",
      };
      const first = await decideProxyRequest(input, deps({ resolveSandboxRun }));
      const second = await decideProxyRequest(input, deps({ resolveSandboxRun }));
      expect(resolveSandboxRun).toHaveBeenCalledTimes(2);
      // Different deny REASONS for byte-identical input proves decide()
      // was re-run fresh against the second call's own (changed) role,
      // not served from anything cached by the first: executor is
      // push-capable (denied for zero ref updates in an empty pkt-line
      // body), code-reviewer isn't push-capable at all (denied earlier,
      // before ref updates are even inspected).
      expect(first).toMatchObject({ allow: false, reason: "receive_pack_no_ref_updates" });
      expect(second).toMatchObject({ allow: false, reason: "receive_pack_requires_push_capable_role" });
    });
  });

  describe("B7: query-string validation", () => {
    it("a git request carrying an extra query key beyond service is denied", async () => {
      const result = await decideProxyRequest(
        {
          method: "GET",
          path: "/acme/widgets.git/info/refs",
          query: { service: "git-upload-pack", repo: "other-repo" },
          rawBody: body(""),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "query_not_allowed" });
    });

    it("a REST request smuggling a merge query parameter is denied", async () => {
      const result = await decideProxyRequest(
        {
          method: "GET",
          path: "/repos/acme/widgets/issues/5",
          query: { merge: "true" },
          rawBody: body(""),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "query_not_allowed" });
    });

    it("a REST request smuggling a second repo through the query string is denied", async () => {
      const result = await decideProxyRequest(
        {
          method: "GET",
          path: "/repos/acme/widgets/issues/5",
          query: { repo: "other" },
          rawBody: body(""),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "query_not_allowed" });
    });
  });

  it("token_mint_failed denies with 403 and never lets a decide()-allowed request through unforwarded silently", async () => {
    const requester: AccessTokenRequester = vi.fn(async () => {
      throw new Error("mint down for acme/widgets with ghs_FAKE_h1b_mint_token");
    });
    const reports = captureReports();
    const result = await decideProxyRequest(
      { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
      deps({ accessTokenRequester: requester }),
    );
    expect(result).toMatchObject({ allow: false, status: 403, reason: "token_mint_failed" });
    // Reported as one coded class: neither the repository nor the token is in it.
    expect(reports.classes).toEqual([{ service: "test", route: "/", stage: "github.proxy_mint", code: "other" }]);
    expect(reports.everything()).not.toMatch(/acme|widgets|ghs_FAKE_h1b_mint_token/);
  });

  it("a mint failure logs the app kind and the error class only, never its message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requester: AccessTokenRequester = vi.fn(async () => {
      throw new Error("upstream said ghs_SECRETTOKENVALUE0123456789");
    });
    await decideProxyRequest(
      { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
      deps({ accessTokenRequester: requester }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain("token mint failed");
    expect(logged).toContain('"error":"InstallationTokenError"');
    expect(logged).not.toContain("SECRETTOKENVALUE");
  });

  it("a mint failure from an unconfigured kind logs its fixed code, which names the kind and no value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requester: AccessTokenRequester = vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const appCredentials = loadAppCredentials({}, () => {});
    const result = await decideProxyRequest(
      { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
      deps({ accessTokenRequester: requester, appCredentials }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(result).toMatchObject({ allow: false, reason: "token_mint_failed" });
    expect(logged).toContain("AppCredentialsError");
    expect(logged).toMatch(/not_configured \(\w+\)/);
  });

  describe("D#2 Correction C28 §3 item 8: mint timeout is 502, not the generic 403", () => {
    it("a MintTimeoutError from the requester denies with 502 upstream_unavailable, not 403 token_mint_failed", async () => {
      const requester: AccessTokenRequester = vi.fn(async () => {
        throw new MintTimeoutError();
      });
      const reports = captureReports();
      const result = await decideProxyRequest(
        { method: "GET", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(""), sandboxName: "x" },
        deps({ accessTokenRequester: requester }),
      );
      expect(result).toMatchObject({ allow: false, status: 502, reason: "upstream_unavailable" });
      // A timeout is an upstream availability failure, and is seen as one.
      expect(reports.classes).toHaveLength(1);
      expect(reports.classes[0]).toMatchObject({ stage: "github.proxy_mint" });
    });
  });

  describe("D#2 Correction C28 §3 item 2: repeated query keys are refused, and only the validated query is forwarded", () => {
    it("a git request with a repeated service key is denied before decide() runs, with zero mint calls", async () => {
      const requester: AccessTokenRequester = vi.fn();
      const result = await decideProxyRequest(
        {
          method: "GET",
          path: "/acme/widgets.git/info/refs",
          query: [
            ["service", "git-receive-pack"],
            ["service", "git-upload-pack"],
          ],
          rawBody: body(""),
          sandboxName: "x",
        },
        deps({ accessTokenRequester: requester }),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "query_not_allowed" });
      expect(requester).not.toHaveBeenCalled();
    });

    it("a REST request with a repeated (otherwise-allowed) key is denied", async () => {
      const result = await decideProxyRequest(
        {
          method: "GET",
          path: "/repos/acme/widgets/issues",
          query: [
            ["page", "1"],
            ["page", "2"],
          ],
          rawBody: body(""),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "query_not_allowed" });
    });

    it("an array query with no duplicates allows, and the result's query is exactly the validated map (criterion (b)/(f): pagination keys survive)", async () => {
      const result = await decideProxyRequest(
        {
          method: "GET",
          path: "/repos/acme/widgets/issues",
          query: [
            ["page", "2"],
            ["per_page", "50"],
          ],
          rawBody: body(""),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: true, query: { page: "2", per_page: "50" } });
    });

    it("a plain Record query (the pre-C28 shape) is still accepted unchanged -- no regression for every existing caller", async () => {
      const result = await decideProxyRequest(
        { method: "GET", path: "/repos/acme/widgets/issues/5", query: { foo: "bar" }, rawBody: body(""), sandboxName: "x" },
        deps(),
      );
      expect(result).toMatchObject({ allow: true, query: { foo: "bar" } });
    });
  });

  describe("D#2 Correction C28 §3 item 6: duplicate JSON keys are refused, at any depth", () => {
    it("a top-level duplicate key on a labels POST is denied with body_invalid, before decide() runs (zero mint calls)", async () => {
      const requester: AccessTokenRequester = vi.fn();
      const result = await decideProxyRequest(
        {
          method: "POST",
          path: "/repos/acme/widgets/issues/5/labels",
          query: {},
          rawBody: body('{"labels":["security-review-passed"],"labels":["bug"]}'),
          sandboxName: "x",
        },
        deps({ accessTokenRequester: requester }),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "body_invalid" });
      expect(requester).not.toHaveBeenCalled();
    });

    it("a duplicate key nested inside a PATCH body's own object value is denied, not just a top-level duplicate", async () => {
      const result = await decideProxyRequest(
        {
          method: "PATCH",
          path: "/repos/acme/widgets/issues/5",
          query: {},
          rawBody: body('{"title":"x","nested":{"a":1,"a":2}}'),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "body_invalid" });
    });

    it("a genuinely malformed (non-duplicate) body still denies with body_unparsable, unchanged", async () => {
      const result = await decideProxyRequest(
        {
          method: "PATCH",
          path: "/repos/acme/widgets/issues/5",
          query: {},
          rawBody: body("{not json"),
          sandboxName: "x",
        },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "body_unparsable" });
    });

    it("H1b: a body so deeply nested that the duplicate-key scan overflows is still denied unparsable, and the scan failure is reported", async () => {
      const depth = 200_000;
      const nested = '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
      const reports = captureReports();
      const result = await decideProxyRequest(
        { method: "PATCH", path: "/repos/acme/widgets/issues/5", query: {}, rawBody: body(nested), sandboxName: "x" },
        deps(),
      );
      expect(result).toMatchObject({ allow: false, status: 403, reason: "body_unparsable" });
      // A RangeError (stack overflow): its class name is reported with the fixed stage; no body text, no repository.
      expect(reports.classes).toEqual([{ service: "test", route: "/", stage: "github.proxy_scan", code: "other" }]);
      expect(reports.everything()).not.toMatch(/acme|widgets|"a":/);
    });

    it("a labels POST with no duplicate keys still allows normally", async () => {
      const result = await decideProxyRequest(
        {
          method: "POST",
          path: "/repos/acme/widgets/issues/5/labels",
          query: {},
          rawBody: body('{"labels":["security-review-passed"]}'),
          sandboxName: "x",
        },
        deps({ resolveSandboxRun: async () => ({ ...RUN, role: "security-reviewer" }) }),
      );
      expect(result).toMatchObject({ allow: true });
    });
  });
});
