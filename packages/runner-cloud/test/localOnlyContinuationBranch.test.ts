import { describe, expect, it } from "vitest";
import { LocalOnlyGithubError, foldContinuationBranchPath, localOnlyGithub, localOnlyViolation, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";

/**
 * D#599 PL-2b-2 (TL ruling R-599-PL2b2-1): A8 takes, as one percent-encoded segment, exactly two branch shapes of a cross-side continuation (the shared
 * ITEM_PR_BRANCH and the shared RUNNER_RUN_BRANCH) and nothing else. The existing one-segment rule for every other name is pinned in localOnlyGithub.test.ts.
 */
const R = "/repos/acme/app";
const RUN = "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d";
const NOT = "not_allowlisted";
const get = (path: string, over: Partial<GithubRequest> = {}): GithubRequest => ({ method: "GET", path, ...over });

async function attempt(req: GithubRequest): Promise<{ result: string; seen: GithubRequest[] }> {
  const seen: GithubRequest[] = [];
  const client: GithubClient = { request: async (r) => (seen.push(r), { status: 404, body: {} }) };
  const result = await localOnlyGithub(client).request(req).then(
    () => "sent",
    (e: unknown) => (e instanceof LocalOnlyGithubError ? e.rule : `other:${String(e)}`),
  );
  return { result, seen };
}

describe("A8 and the two continuation branch shapes", () => {
  it.each([
    ["an item pull request branch", `${R}/branches/fx%2Fissue-12/protection`],
    ["a large issue number", `${R}/branches/fx%2Fissue-1234567890/protection`],
    ["a planned PR child's branch (D#483 S5-b2c-3)", `${R}/branches/fx%2F41-api/protection`],
    ["a run branch", `${R}/branches/fx%2F${RUN}-g1/protection`],
    ["a run branch at generation 123456789", `${R}/branches/fx%2F${RUN}-g123456789/protection`],
  ])("lets %s through, as the encoded path it was sent, with the JSON Accept added", async (_name, path) => {
    expect(localOnlyViolation(get(path))).toBeNull();
    const out = await attempt(get(path));
    expect(out.result).toBe("sent");
    expect(out.seen).toEqual([get(path, { headers: { accept: "application/vnd.github+json" } })]);
  });

  it.each([
    ["another fx name", `${R}/branches/fx%2Fdocs-x/protection`],
    ["a child branch with an upper-case key", `${R}/branches/fx%2F41-API/protection`],
    ["a child branch with a leading zero", `${R}/branches/fx%2F041-api/protection`],
    ["a child branch with a path under it", `${R}/branches/fx%2F41-api%2Fx/protection`],
    ["a child branch with an empty key", `${R}/branches/fx%2F41-/protection`],
    ["fx with a path under it", `${R}/branches/fx%2Fdocs%2Fx/protection`],
    ["a branch named like an item branch with a suffix", `${R}/branches/fx%2Fissue-12-x/protection`],
    ["issues instead of issue", `${R}/branches/fx%2Fissues-12/protection`],
    ["a name outside fx", `${R}/branches/release%2Fissue-12/protection`],
    ["main", `${R}/branches/main%2Fissue-12/protection`],
    ["extra segments after the branch", `${R}/branches/fx%2Fissue-12/protection/restrictions`],
    ["extra segments before it", `${R}/branches/x%2F..%2Ffx%2Fissue-12/protection`],
    ["an unencoded slash", `${R}/branches/fx/issue-12/protection`],
    ["a double encoding", `${R}/branches/fx%252Fissue-12/protection`],
    ["a double encoding of the whole segment", `${R}/branches/fx%252Fissue-12%252Fprotection`],
    ["a dot-dot tail", `${R}/branches/fx%2F../protection`],
    ["an encoded dot-dot tail", `${R}/branches/fx%2F%2e%2e/protection`],
    ["a lower-case %2f (only the capital form is the canonical one)", `${R}/branches/fx%2fissue-12/protection`],
    ["an upper-case branch", `${R}/branches/FX%2Fissue-12/protection`],
    ["a trailing slash", `${R}/branches/fx%2Fissue-12/protection/`],
    ["a leading zero", `${R}/branches/fx%2Fissue-07/protection`],
    ["issue zero", `${R}/branches/fx%2Fissue-0/protection`],
    ["eleven digits", `${R}/branches/fx%2Fissue-12345678901/protection`],
    ["a run id with an upper-case letter", `${R}/branches/fx%2F${RUN.toUpperCase()}-g1/protection`],
    ["generation zero", `${R}/branches/fx%2F${RUN}-g0/protection`],
    ["a generation with a leading zero", `${R}/branches/fx%2F${RUN}-g01/protection`],
    ["an escaped owner", `/repos/ac%6de/app/branches/fx%2Fissue-12/protection`],
  ])("refuses %s", async (_name, path) => {
    expect((await attempt(get(path))).result, path).toBe(NOT);
  });

  it("still refuses every non-GET method, a query, a body and a fragment on the folded path", async () => {
    const path = `${R}/branches/fx%2Fissue-12/protection`;
    const cases: GithubRequest[] = [
      get(path, { method: "PUT", body: {} }),
      get(path, { method: "POST", body: {} }),
      get(path, { method: "DELETE" }),
      get(path, { query: { x: "1" } }),
      get(`${path}?x=1`),
      get(`${path}#frag`),
      get(path, { body: {} }),
    ];
    for (const req of cases) expect((await attempt(req)).result, `${req.method} ${req.path}`).toBe(NOT);
    expect((await attempt(get(path, { headers: { accept: "application/vnd.github.diff" } }))).result).toBe("accept");
  });

  it("the fold changes nothing for a path it does not accept, and never lets a request through that the old rule refused", () => {
    for (const p of [`${R}/branches/main/protection`, `${R}/branches/release%2F1/protection`, `${R}/pulls`, `${R}/branches/fx%2Fdocs-x/protection`]) {
      expect(foldContinuationBranchPath(p)).toBe(p);
    }
    expect(localOnlyViolation(get(`${R}/branches/release%2F1/protection`))).toBe(NOT);
    expect(foldContinuationBranchPath(`${R}/branches/fx%2Fissue-12/protection`)).toBe(`${R}/branches/fx-continuation/protection`);
  });
});
