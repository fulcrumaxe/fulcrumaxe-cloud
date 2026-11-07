import { describe, expect, it } from "vitest";
import type { GitHubHttp, GitHubHttpRequest, LocalGitHubHttp } from "../../src/build/githubMergePort.js";
import { readGate1CreatorFor, readGate1CreatorRest } from "../../src/review/gate1Creator.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1e: who posted `fx-gate1`, for a hosted pair, from REST `commits/{sha}/statuses` (newest first, `creator: { login, type }`).
 * The same rule as the fenced A17 read: our App's bot only (type `Bot`, login exactly our slug or `<slug>[bot]`), GitHub's state upper case.
 */
const SHA = "c".repeat(40);
const repo = { owner: "acme", name: "widgets-public", sha: SHA };
const OURS = { login: "fx-cloud-app[bot]", type: "Bot" };
type Status = { context: string; state: string; creator?: unknown };

/** A REST client answering `pages` (each a list, newest first) and recording every call. */
function rest(pages: unknown[][], status = 200): GitHubHttp & { calls: GitHubHttpRequest[] } {
  const calls: GitHubHttpRequest[] = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const p = Number(req.query?.page ?? 1);
      return { status, body: pages[p - 1] ?? [] };
    },
  };
}
const st = (context: string, state: string, creator: unknown = OURS): Status => ({ context, state, creator });

describe("readGate1CreatorRest", () => {
  it("our App's bot by its REST login or bare slug, typed Bot: ours, with GitHub's state upper-cased (each state mapped, not a constant)", async () => {
    for (const login of ["fx-cloud-app[bot]", "fx-cloud-app"]) {
      for (const ourLogin of ["fx-cloud-app[bot]", "fx-cloud-app"]) {
        for (const [state, upper] of [["success", "SUCCESS"], ["failure", "FAILURE"], ["error", "ERROR"], ["pending", "PENDING"]] as const) {
          const http = rest([[st("fx-gate1", state, { login, type: "Bot" })]]);
          expect(await readGate1CreatorRest(http, repo, ourLogin), `${login} ${ourLogin} ${state}`).toEqual({ state: upper, ours: true });
        }
      }
    }
    const http = rest([[st("fx-gate1", "success")]]);
    await readGate1CreatorRest(http, repo, "fx-cloud-app[bot]");
    expect(http.calls).toEqual([{ method: "GET", path: `/repos/acme/widgets-public/commits/${SHA}/statuses`, query: { per_page: 100, page: 1 } }]);
  });

  it("not ours: another type, case, prefix, suffix, another app, no creator, a REST user login that ends in [bot], and an empty login of ours", async () => {
    const creators = [
      { login: "fx-cloud-app[bot]", type: "User" },
      { login: "fx-cloud-app", type: "Organization" },
      { login: "fx-cloud-app[bot]", type: "bot" },
      { login: "Fx-Cloud-App[bot]", type: "Bot" },
      { login: "fx-cloud-app2[bot]", type: "Bot" },
      { login: "x-fx-cloud-app[bot]", type: "Bot" },
      { login: "fx-cloud-app[bot][bot]", type: "Bot" },
      { login: "other-app[bot]", type: "Bot" },
      { type: "Bot" },
      { login: "fx-cloud-app[bot]" },
      null,
      "fx-cloud-app[bot]",
    ];
    for (const creator of creators) expect(await readGate1CreatorRest(rest([[st("fx-gate1", "success", creator)]]), repo, "fx-cloud-app[bot]"), JSON.stringify(creator)).toEqual({ state: "SUCCESS", ours: false });
    for (const ourLogin of ["", "[bot]"]) expect((await readGate1CreatorRest(rest([[st("fx-gate1", "success", { login: "[bot]", type: "Bot" })]]), repo, ourLogin)).ours).toBe(false);
  });

  it("the newest fx-gate1 decides: a person's success after ours is foreign, our failure after our success is a failure; other contexts and lookalike context names are skipped", async () => {
    expect(await readGate1CreatorRest(rest([[st("fx-gate1", "success", { login: "autonomous-agent-7", type: "User" }), st("fx-gate1", "success")]]), repo, "fx-cloud-app")).toEqual({ state: "SUCCESS", ours: false });
    expect(await readGate1CreatorRest(rest([[st("fx-gate1", "failure"), st("fx-gate1", "success")]]), repo, "fx-cloud-app")).toEqual({ state: "FAILURE", ours: true });
    const skipped = [st("FX-GATE1", "failure", { login: "x", type: "User" }), st("fx-gate1 ", "failure", { login: "x", type: "User" }), st("fulcrumaxe/review", "failure", { login: "x", type: "User" }), st("fx-gate1", "success")];
    expect(await readGate1CreatorRest(rest([skipped]), repo, "fx-cloud-app")).toEqual({ state: "SUCCESS", ours: true });
  });

  it("pages: an fx-gate1 on page 2 is found; a short list without one has none; full pages without one past the cap is a throw (unknown, never none)", async () => {
    const full = Array.from({ length: 100 }, (_, i) => st(`ctx-${i}`, "success"));
    const two = rest([full, [st("fx-gate1", "success")]]);
    expect(await readGate1CreatorRest(two, repo, "fx-cloud-app")).toEqual({ state: "SUCCESS", ours: true });
    expect(two.calls.map((c) => c.query?.page)).toEqual([1, 2]);
    expect(await readGate1CreatorRest(rest([[st("other", "success")]]), repo, "fx-cloud-app")).toEqual({ state: null, ours: false });
    expect(await readGate1CreatorRest(rest([]), repo, "fx-cloud-app")).toEqual({ state: null, ours: false });
    const endless = rest(Array.from({ length: 6 }, () => full));
    await expect(readGate1CreatorRest(endless, repo, "fx-cloud-app")).rejects.toThrow(/beyond the pages/);
    expect(endless.calls).toHaveLength(5);
  });

  it("a failed read, a body that is not a list, a malformed entry or state, or a malformed sha is a throw", async () => {
    await expect(readGate1CreatorRest(rest([[st("fx-gate1", "success")]], 502), repo, "fx-cloud-app")).rejects.toThrow(/gate1 creator/);
    await expect(readGate1CreatorRest({ request: async () => ({ status: 200, body: { statuses: [] } }) }, repo, "fx-cloud-app")).rejects.toThrow(/gate1 creator/);
    await expect(readGate1CreatorRest(rest([[null]]), repo, "fx-cloud-app")).rejects.toThrow(/gate1 creator/);
    await expect(readGate1CreatorRest(rest([[{ context: "fx-gate1", state: null, creator: OURS }]]), repo, "fx-cloud-app")).rejects.toThrow(/gate1 creator/);
    const none = rest([[st("fx-gate1", "success")]]);
    await expect(readGate1CreatorRest(none, { ...repo, sha: "main" }, "fx-cloud-app")).rejects.toThrow(/gate1 creator/);
    expect(none.calls).toEqual([]);
  });
});

describe("readGate1CreatorFor", () => {
  it("a fenced client reads A17 (no REST); a plain client reads REST (no GraphQL)", async () => {
    const ops: string[] = [];
    const local: LocalGitHubHttp = {
      request: async () => Promise.reject(new Error("no REST on the fenced path")),
      graphql: async (op) => (ops.push(op), { status: 200, body: { data: { repository: { object: { oid: SHA, status: { context: { state: "SUCCESS", creator: { __typename: "Bot", login: "fx-cloud-app" } } } } } } } }),
    };
    expect(await readGate1CreatorFor(local, repo, "fx-cloud-app[bot]")).toEqual({ state: "SUCCESS", ours: true });
    expect(ops).toEqual(["Gate1Status"]);
    const plain = rest([[st("fx-gate1", "success", { login: "autonomous-agent-7", type: "User" })]]);
    expect(await readGate1CreatorFor(plain, repo, "fx-cloud-app[bot]")).toEqual({ state: "SUCCESS", ours: false });
    expect(plain.calls).toHaveLength(1);
  });
});
