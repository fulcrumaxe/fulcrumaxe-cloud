import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createInstallationHttp, mergeGateCompareAllowed, type InstallationHttpKind } from "../src/installationHttp.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/**
 * The merge gate's three-dot compare (`GET compare/<base>...<head>`), against the strict GitHub fetch fake and the real token minter. Every other path with
 * `..` in it stays refused, on every kind, and a compare stays refused on every kind but `merge_gate`.
 *
 * Not faked faithfully: how GitHub itself reads a compare path with an odd ref name (the shapes refused here are refused before a request, so GitHub never sees them).
 */
const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const BASE = "/repos/acme/widgets";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(64);
let privateKeyPem: string;
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

function setup() {
  const calls: string[] = [];
  const requester: AccessTokenRequester = async (p) => ({ token: "fake-install-token-compare", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions } as Record<string, string>, repositories: p.repositories ?? [] });
  const fetchImpl = strictGithubFetch((async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    return new Response(JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0, merge_base_commit: { sha: A }, files: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch);
  const open = createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });
  return { open, calls };
}

describe("merge_gate: the three-dot compare", () => {
  it.each<[string, string, Record<string, string | number> | undefined]>([
    // The shapes the gate's callers build: the content check (branch...head, then base...head), the ordering overlap and the queue refresh (encoded base ref...head), the merge-only recheck (sha...branch).
    ["the default branch against a head", `${BASE}/compare/main...${A}`, { per_page: 1 }],
    ["a merge base against a head, every file", `${BASE}/compare/${A}...${B}`, undefined],
    ["an empty query object", `${BASE}/compare/${A}...${B}`, {}],
    ["a branch with slashes and dots", `${BASE}/compare/release/v1.2/next...${A}`, { per_page: 1 }],
    ["a commit against a branch", `${BASE}/compare/${A}...main`, { per_page: 1 }],
    ["64-hex ids", `${BASE}/compare/${C}...${C}`, undefined],
  ])("sends %s", async (_name, path, query) => {
    const t = setup();
    const http = await t.open("merge_gate", TARGET);
    const res = await http.request({ method: "GET", path, ...(query !== undefined ? { query } : {}) });
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.startsWith(path)).toBe(true);
  });

  it.each<[string, string, string, Record<string, string | number> | undefined, unknown?]>([
    ["a two-dot compare", "GET", `${BASE}/compare/${A}..${B}`, undefined],
    ["a four-dot compare", "GET", `${BASE}/compare/${A}....${B}`, undefined],
    ["two separators", "GET", `${BASE}/compare/${A}...main...${B}`, undefined],
    ["a .diff suffix", "GET", `${BASE}/compare/${A}...${B}.diff`, undefined],
    ["a .patch suffix", "GET", `${BASE}/compare/main...${B}.patch`, undefined],
    ["an upper-case .DIFF suffix", "GET", `${BASE}/compare/main...${B}.DIFF`, undefined],
    ["a trailing slash", "GET", `${BASE}/compare/${A}...${B}/`, undefined],
    ["an empty base", "GET", `${BASE}/compare/...${B}`, undefined],
    ["an empty head", "GET", `${BASE}/compare/${A}...`, undefined],
    ["a dot-led base segment", "GET", `${BASE}/compare/.hidden...${B}`, undefined],
    ["a base ending in a dot", "GET", `${BASE}/compare/main....${B}`, undefined],
    ["a `..` segment in the base", "GET", `${BASE}/compare/../contents/x...${B}`, undefined],
    ["traversal out of the repository", "GET", `${BASE}/../other/compare/${A}...${B}`, undefined],
    ["a percent escape in a ref", "GET", `${BASE}/compare/fx%2Fissue-1...${B}`, undefined],
    ["another repository's compare", "GET", `/repos/acme/other/compare/${A}...${B}`, undefined],
    ["a compare below another path", "GET", `${BASE}/pulls/compare/${A}...${B}`, undefined],
    ["per_page 2", "GET", `${BASE}/compare/${A}...${B}`, { per_page: 2 }],
    ["a page key", "GET", `${BASE}/compare/${A}...${B}`, { per_page: 1, page: 2 }],
    ["another query key", "GET", `${BASE}/compare/${A}...${B}`, { recursive: "1" }],
    ["a POST", "POST", `${BASE}/compare/${A}...${B}`, undefined, {}],
    ["a GET with a body", "GET", `${BASE}/compare/${A}...${B}`, undefined, { x: 1 }],
    ["a `..` anywhere else", "GET", `${BASE}/git/trees/${A}/..`, undefined],
  ])("refuses %s before a request is sent", async (_name, method, path, query, body) => {
    const t = setup();
    const http = await t.open("merge_gate", TARGET);
    await expect(http.request({ method: method as "GET", path, ...(query !== undefined ? { query } : {}), ...(body !== undefined ? { body } : {}) })).rejects.toThrow(/path_refused|method_refused/);
    expect(t.calls).toEqual([]);
  });

  it("every other kind still refuses a compare: the exemption is the merge gate's alone", async () => {
    const t = setup();
    const others: Array<[InstallationHttpKind, Record<string, unknown>]> = [
      ["read", {}],
      ["read", { allowGraphql: true }],
      ["runner_pr", {}],
      ["repo_map", {}],
      ["plane_parity", {}],
      ["receipt_block", { prNumber: 3 }],
      ["revert_pr", { prNumber: 3 }],
      ["branch_sync", { prNumber: 3, branch: "fx/issue-3" }],
    ];
    for (const [kind, extra] of others) {
      const http = await t.open(kind, { ...TARGET, ...extra });
      for (const path of [`${BASE}/compare/main...${A}`, `${BASE}/compare/${A}...${B}`]) {
        await expect(http.request({ method: "GET", path, query: { per_page: 1 } }), `${kind} ${path}`).rejects.toThrow(/path_refused|method_refused/);
      }
    }
    expect(t.calls).toEqual([]);
  });

  it("the predicate on its own: method, body, prefix and query are each required", () => {
    const prefix = `${BASE}/`;
    const path = `${BASE}/compare/main...${A}`;
    expect(mergeGateCompareAllowed("GET", path, undefined, undefined, prefix)).toBe(true);
    expect(mergeGateCompareAllowed("GET", path, { per_page: "1" }, undefined, prefix)).toBe(true);
    expect(mergeGateCompareAllowed("HEAD", path, undefined, undefined, prefix)).toBe(false);
    expect(mergeGateCompareAllowed("GET", path, undefined, null, prefix)).toBe(false);
    expect(mergeGateCompareAllowed("GET", path, undefined, undefined, "/repos/acme/other/")).toBe(false);
    expect(mergeGateCompareAllowed("GET", path, { per_page: "01" }, undefined, prefix)).toBe(false);
    expect(mergeGateCompareAllowed("GET", path, { per_page: "1", x: "1" }, undefined, prefix)).toBe(false);
    // Eleven segments in one ref is past the bound.
    expect(mergeGateCompareAllowed("GET", `${BASE}/compare/${Array.from({ length: 11 }, () => "a").join("/")}...${A}`, undefined, undefined, prefix)).toBe(false);
    expect(mergeGateCompareAllowed("GET", `${BASE}/compare/${Array.from({ length: 10 }, () => "a").join("/")}...${A}`, undefined, undefined, prefix)).toBe(true);
  });
});
