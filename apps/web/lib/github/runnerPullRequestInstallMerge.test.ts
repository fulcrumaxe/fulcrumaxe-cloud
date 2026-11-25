import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createInstallationHttp, InstallationTokenCache, type AccessTokenRequester, type InstallationHttpRequest } from "@fx/github";
import { strictGithubFetch } from "../../../../packages/github/test/helpers/strictGithub.js";
import { createAppRunPullRequestPort } from "./runnerPullRequest";

const REPO = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const SHA = "c".repeat(40);

/**
 * D#845 ON-20a: the install merge goes through the merge gate's installation kind (the one pull request kind whose token holds contents write), behind the port's pin to one pull request and one head.
 * The first test sees which kind the wiring opens and what it sends; the second drives the port over the REAL installation client (its path rule and its token minter) behind the strict GitHub fetch.
 */
describe("the install merge through the live installation kinds", () => {
  it("opens the merge_gate kind (never the pull request kind) and sends one PUT of exactly sha and merge_method; the file stats go through the pull request kind", async () => {
    const opened: unknown[] = [];
    const sent: InstallationHttpRequest[] = [];
    const port = createAppRunPullRequestPort({
      open: async (kind, target) => {
        opened.push([kind, target.repoId]);
        return { request: async (req) => (sent.push(req), req.method === "PUT" ? { status: 200, body: { merged: true, sha: "f".repeat(40) } } : { status: 200, body: { data: { repository: { pullRequest: null } } } }) };
      },
    });
    expect(await port.mergeInstall({ repo: REPO, number: 7, sha: SHA })).toBe("merged");
    expect(opened).toEqual([["merge_gate", REPO.id]]);
    expect(sent).toEqual([{ method: "PUT", path: "/repos/acme/widgets/pulls/7/merge", query: undefined, body: { sha: SHA, merge_method: "squash" } }]);
    await port.installPullRequest({ repo: REPO, number: 7 }).catch(() => undefined);
    expect(opened.at(-1)).toEqual(["runner_pr", REPO.id]);
  });

  let pem: string;
  beforeAll(() => {
    pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  });

  it("merges over the real merge_gate client with a contents-and-pull-requests-write token", async () => {
    const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    const requester: AccessTokenRequester = async (p) => (minted.push(p), { token: "ghs_live_1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: p.permissions as Record<string, string>, ...(p.repositories ? { repositories: p.repositories } : {}) });
    const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      sent.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ merged: true, sha: "f".repeat(40), message: "Pull Request successfully merged" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);
    const open = createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem: pem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
    const port = createAppRunPullRequestPort({ open });
    expect(await port.mergeInstall({ repo: REPO, number: 7, sha: SHA })).toBe("merged");
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ repositories: ["widgets"], permissions: { metadata: "read", contents: "write", pull_requests: "write" } });
    expect(sent).toEqual([{ method: "PUT", path: "/repos/acme/widgets/pulls/7/merge", body: { sha: SHA, merge_method: "squash" } }]);
  });
});
