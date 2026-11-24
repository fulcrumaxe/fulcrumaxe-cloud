import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createInstallationHttp, InstallationTokenCache, type AccessTokenRequester, type InstallationHttpRequest } from "@fx/github";
import { LocalOnlyGithubError, RunPullRequestError } from "@fx/runner-cloud";
import { strictGithubFetch } from "../../../../packages/github/test/helpers/strictGithub.js";
import { createAppRunPullRequestPort } from "./runnerPullRequest";

/** D#6 R2b-3e: the app's wiring of the `done` pull request port: the runner_pr installation client, behind the allowlist. */
const REPO = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };

function setup(answer: (req: InstallationHttpRequest) => { status: number; body: unknown }) {
  const opened: unknown[] = [];
  const sent: InstallationHttpRequest[] = [];
  const port = createAppRunPullRequestPort({
    open: async (kind, target) => {
      opened.push([kind, target]);
      return { request: async (req) => (sent.push(req), answer(req)) };
    },
  });
  return { port, opened, sent };
}

describe("createAppRunPullRequestPort", () => {
  it("opens the runner_pr client for the repo by id, and sends the call without caller headers", async () => {
    const t = setup(() => ({ status: 200, body: { full_name: "acme/widgets", default_branch: "main" } }));
    expect(await t.port.defaultBranch(REPO)).toBe("main");
    expect(t.opened).toEqual([["runner_pr", { repoId: REPO.id, owner: "acme", name: "widgets" }]]);
    expect(t.sent).toEqual([{ method: "GET", path: "/repos/acme/widgets", query: undefined, body: undefined }]);
  });

  it("sends a draft pull request, and a graphql document, through the same client", async () => {
    const t = setup((req) => (req.path === "/graphql" ? { status: 200, body: { errors: [{ type: "FORBIDDEN" }] } } : { status: 200, body: [] }));
    await t.port.changedFiles({ repo: REPO, number: 4 }).catch(() => undefined);
    expect(t.sent.map((r) => [r.method, r.path])).toEqual([["POST", "/graphql"]]);
    expect((t.sent[0]!.body as { variables: unknown }).variables).toEqual({ owner: "acme", name: "widgets", number: 4 });
  });

  it("a call outside the allowlist never reaches the client (the fence is applied by the port, not by this file)", async () => {
    const t = setup(() => ({ status: 200, body: {} }));
    // Closing is allowed, but pull request number -1 is not a number the allowlist accepts: the wrapper throws before the client is asked.
    await expect(t.port.close({ repo: REPO, number: -1 })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(t.sent).toEqual([]);
  });

  it("an installation that cannot be opened is unavailable, with a fixed reason that holds none of the cause", async () => {
    const port = createAppRunPullRequestPort({
      open: async () => {
        throw new Error("installationHttp: no_installation for acme/widgets");
      },
    });
    const error = (await port.defaultBranch(REPO).catch((e: unknown) => e)) as RunPullRequestError;
    expect(error).toBeInstanceOf(RunPullRequestError);
    expect(error.reason).toBe("unavailable");
    expect(error.message).not.toContain("acme");
  });
});

/**
 * D#845 ON-8f2b: the install step's labels are created through the `setup_labels` kind. The first test sees which kind the wiring opens; the second drives the port over the REAL installation client
 * (its exact path list and token minter) behind the strict GitHub fetch, so a label call the live client would refuse (the `runner_pr` kind refuses `/labels`) fails here, as the old fake-only tests did not.
 */
describe("ensureLabels through the live installation kinds", () => {
  const T = { repoId: REPO.id, owner: "acme", name: "widgets" };
  let pem: string;
  beforeAll(() => {
    pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  });
  const created = { id: 1, node_id: "LA_x", name: "x", color: "ededed", description: "", default: false };
  const exists = { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }], documentation_url: "https://docs.github.com/rest/issues/labels#create-a-label", status: "422" };

  function live(answer: (name: string) => Response) {
    const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const revokes: string[] = [];
    const requester: AccessTokenRequester = async (p) => (minted.push(p), { token: "ghs_live_1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: p.permissions as Record<string, string>, ...(p.repositories ? { repositories: p.repositories } : {}) });
    const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/installation/token") return (revokes.push(`${method} ${(init?.headers as Record<string, string> | undefined)?.authorization}`), new Response(null, { status: 204 }));
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
      sent.push({ method, path: url.pathname, body });
      if (method === "POST" && url.pathname === "/repos/acme/widgets/labels") return answer((body as { name: string }).name);
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch);
    const open = createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem: pem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
    return { open, minted, sent, revokes };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("opens the setup_labels kind (and no pull request kind) for the labels", async () => {
    const t = setup(() => ({ status: 201, body: created }));
    await t.port.ensureLabels({ repo: REPO });
    expect(t.opened).toEqual([["setup_labels", T]]);
    expect(t.sent.length).toBeGreaterThan(0);
    for (const r of t.sent) expect([r.method, r.path]).toEqual(["POST", "/repos/acme/widgets/labels"]);
  });

  it("creates every label over the real installation client with an issues-write token; a label that exists counts as made", async () => {
    const t = live((name) => (name === "spec_ready" ? json(422, exists) : json(201, created)));
    const port = createAppRunPullRequestPort({ open: t.open });
    await port.ensureLabels({ repo: REPO });
    expect(t.minted).toHaveLength(1);
    expect(t.minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", issues: "write" } });
    expect(t.sent.length).toBeGreaterThanOrEqual(11);
    for (const r of t.sent) {
      expect([r.method, r.path]).toEqual(["POST", "/repos/acme/widgets/labels"]);
      expect(Object.keys(r.body as object).sort()).toEqual(["color", "description", "name"]);
    }
  });

  it("revokes the setup_labels token exactly once when the labels are made, and exactly once when a label is refused (CWE-613)", async () => {
    const ok = live(() => json(201, created));
    await createAppRunPullRequestPort({ open: ok.open }).ensureLabels({ repo: REPO });
    expect(ok.revokes).toEqual(["DELETE Bearer ghs_live_1"]);
    // a label GitHub refuses (403) fails the call, and the token is still revoked, once
    let seen = 0;
    const refused = live(() => (++seen === 3 ? json(403, { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com/rest", status: "403" }) : json(201, created)));
    await expect(createAppRunPullRequestPort({ open: refused.open }).ensureLabels({ repo: REPO })).rejects.toBeInstanceOf(RunPullRequestError);
    expect(refused.revokes).toEqual(["DELETE Bearer ghs_live_1"]);
    // the pull request kind has no token to release: nothing is revoked for it
    const pr = live(() => json(200, {}));
    await createAppRunPullRequestPort({ open: pr.open }).defaultBranch(REPO).catch(() => undefined);
    expect(pr.revokes).toEqual([]);
  });

  it("a pull request client alone cannot make a label: the real runner_pr kind refuses it before any request (the bug)", async () => {
    const t = live(() => json(201, created));
    const port = createAppRunPullRequestPort({ open: (_kind, target) => t.open("runner_pr", target) });
    const error = (await port.ensureLabels({ repo: REPO }).catch((e: unknown) => e)) as RunPullRequestError;
    expect(error).toBeInstanceOf(RunPullRequestError);
    expect(t.sent).toEqual([]);
    expect(t.minted[0]!.permissions).toEqual({ metadata: "read", contents: "read", pull_requests: "write" });
  });
});
