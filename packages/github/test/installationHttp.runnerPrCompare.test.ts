import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, runnerPrCompareAllowed, type InstallationHttpKind } from "../src/installationHttp.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * D#845 ON-27d3 (A32): the one compare a `runner_pr` client may read, `GET compare/<40 hex>...<40 hex>` with no query and no body, for the twin sync's rename check. Every other compare stays refused on this kind,
 * and the exemption is this kind's (and the merge gate's own) alone.
 *
 * Not faked faithfully: how GitHub paginates a compare's files past 300 (the port treats a list that long as incomplete).
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const BASE = "/repos/acme/widgets";
const A = "a".repeat(40);
const B = "b".repeat(40);
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

function setup() {
  const calls: string[] = [];
  const requester: AccessTokenRequester = async (p) => ({ token: "fake-install-token-runner-compare", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions } as Record<string, string>, repositories: p.repositories ?? [] });
  const fetchImpl = strictGithubFetch((async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    return new Response(JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, files: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch);
  const open = createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
  return { open, calls };
}

describe("runner_pr: the one compare of two commit ids", () => {
  it("sends it, once, and reads the answer", async () => {
    const t = setup();
    const http = await t.open("runner_pr", TARGET);
    const res = await http.request({ method: "GET", path: `${BASE}/compare/${A}...${B}` });
    expect(res.status).toBe(200);
    expect(t.calls).toEqual([`${BASE}/compare/${A}...${B}`]);
    // an empty query object is no query
    await http.request({ method: "GET", path: `${BASE}/compare/${B}...${A}`, query: {} });
    expect(t.calls).toHaveLength(2);
  });

  it.each<[string, string, string, Record<string, string | number> | undefined, unknown?]>([
    ["a branch name", "GET", `${BASE}/compare/main...${B}`, undefined],
    ["a branch on the head side", "GET", `${BASE}/compare/${A}...main`, undefined],
    ["64-hex ids", "GET", `${BASE}/compare/${"c".repeat(64)}...${"c".repeat(64)}`, undefined],
    ["a short id", "GET", `${BASE}/compare/${"a".repeat(39)}...${B}`, undefined],
    ["upper-case hex", "GET", `${BASE}/compare/${"A".repeat(40)}...${B}`, undefined],
    ["a two-dot compare", "GET", `${BASE}/compare/${A}..${B}`, undefined],
    ["a four-dot compare", "GET", `${BASE}/compare/${A}....${B}`, undefined],
    ["a .diff suffix", "GET", `${BASE}/compare/${A}...${B}.diff`, undefined],
    ["a .patch suffix", "GET", `${BASE}/compare/${A}...${B}.patch`, undefined],
    ["a trailing slash", "GET", `${BASE}/compare/${A}...${B}/`, undefined],
    ["a percent escape", "GET", `${BASE}/compare/${A}...${B.slice(0, 38)}%61a`, undefined],
    ["another repository", "GET", `/repos/acme/other/compare/${A}...${B}`, undefined],
    ["a compare below another path", "GET", `${BASE}/pulls/compare/${A}...${B}`, undefined],
    ["any query", "GET", `${BASE}/compare/${A}...${B}`, { per_page: 1 }],
    ["a page key", "GET", `${BASE}/compare/${A}...${B}`, { page: 2 }],
    ["a POST", "POST", `${BASE}/compare/${A}...${B}`, undefined, {}],
    ["a PUT", "PUT", `${BASE}/compare/${A}...${B}`, undefined, {}],
    ["a GET with a body", "GET", `${BASE}/compare/${A}...${B}`, undefined, { x: 1 }],
    ["a `..` anywhere else", "GET", `${BASE}/git/trees/${A}/..`, undefined],
  ])("refuses %s before a request is sent", async (_name, method, path, query, body) => {
    const t = setup();
    const http = await t.open("runner_pr", TARGET);
    await expect(http.request({ method: method as "GET", path, ...(query !== undefined ? { query } : {}), ...(body !== undefined ? { body } : {}) })).rejects.toThrow(/path_refused|method_refused/);
    expect(t.calls).toEqual([]);
  });

  it("no other kind gains it: the read, repo map, branch and receipt kinds and the token-minting ones still refuse a compare", async () => {
    const t = setup();
    const others: Array<[InstallationHttpKind, Record<string, unknown>]> = [
      ["read", {}],
      ["repo_map", {}],
      ["plane_parity", {}],
      ["setup_labels", {}],
      ["setup_finish", {}],
      ["receipt_block", { prNumber: 3 }],
      ["revert_pr", { prNumber: 3 }],
      ["branch_sync", { prNumber: 3, branch: "fx/issue-3" }],
    ];
    for (const [kind, extra] of others) {
      const http = await t.open(kind, { ...TARGET, ...extra });
      await expect(http.request({ method: "GET", path: `${BASE}/compare/${A}...${B}` }), kind).rejects.toThrow(/path_refused|method_refused/);
    }
    expect(t.calls).toEqual([]);
  });

  it("the predicate on its own: method, body, query and prefix are each required", () => {
    const prefix = `${BASE}/`;
    const path = `${BASE}/compare/${A}...${B}`;
    expect(runnerPrCompareAllowed("GET", path, undefined, undefined, prefix)).toBe(true);
    expect(runnerPrCompareAllowed("GET", path, {}, undefined, prefix)).toBe(true);
    expect(runnerPrCompareAllowed("GET", path, { per_page: "1" }, undefined, prefix)).toBe(false);
    expect(runnerPrCompareAllowed("HEAD", path, undefined, undefined, prefix)).toBe(false);
    expect(runnerPrCompareAllowed("GET", path, undefined, null, prefix)).toBe(false);
    expect(runnerPrCompareAllowed("GET", path, undefined, undefined, "/repos/acme/other/")).toBe(false);
  });
});
