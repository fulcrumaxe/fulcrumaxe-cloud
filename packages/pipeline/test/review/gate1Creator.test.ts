import { describe, expect, it } from "vitest";
import type { LocalGitHubHttp } from "../../src/build/githubMergePort.js";
import { readGate1Creator } from "../../src/review/gate1Creator.js";

/** D#6 CLOUD-POSTS-FX-GATE1 PR 1c: the A17 answer read into "who posted fx-gate1", exactly. The fenced path is covered in mergeGatePairedLocal.pg.test.ts. */
const SHA = "c".repeat(40);
const repo = { owner: "acme", name: "widgets-public", sha: SHA };
const answer = (body: unknown, status = 200): LocalGitHubHttp & { ops: string[] } => {
  const ops: string[] = [];
  return { ops, request: async () => Promise.reject(new Error("no REST")), graphql: async (op) => (ops.push(op), { status, body }) };
};
const ctx = (context: unknown, oid = SHA) => ({ data: { repository: { object: { oid, status: context === undefined ? null : { context } } } } });

describe("readGate1Creator", () => {
  it("our App's bot, by slug or by its [bot] login, with GitHub's state as given", async () => {
    for (const login of ["fx-cloud-app", "fx-cloud-app[bot]"]) {
      for (const ourLogin of ["fx-cloud-app[bot]", "fx-cloud-app"]) {
        const http = answer(ctx({ state: "SUCCESS", creator: { __typename: "Bot", login } }));
        expect(await readGate1Creator(http, repo, ourLogin)).toEqual({ state: "SUCCESS", ours: true });
        expect(http.ops).toEqual(["Gate1Status"]);
      }
    }
    expect(await readGate1Creator(answer(ctx({ state: "FAILURE", creator: { __typename: "Bot", login: "fx-cloud-app" } })), repo, "fx-cloud-app[bot]")).toEqual({ state: "FAILURE", ours: true });
  });

  it("not ours: another type, another login, case, prefix or suffix, no creator, and an empty login of ours", async () => {
    const creators = [{ __typename: "User", login: "fx-cloud-app" }, { __typename: "Organization", login: "fx-cloud-app" }, { __typename: "Mannequin", login: "fx-cloud-app" }, { __typename: "Bot", login: "Fx-Cloud-App" }, { __typename: "Bot", login: "fx-cloud-app2" }, { __typename: "Bot", login: "x-fx-cloud-app" }, { __typename: "Bot", login: "fx-cloud-app[bot][bot]" }, { __typename: "Bot" }, null];
    for (const creator of creators) expect(await readGate1Creator(answer(ctx({ state: "SUCCESS", creator })), repo, "fx-cloud-app[bot]"), JSON.stringify(creator)).toEqual({ state: "SUCCESS", ours: false });
    for (const ourLogin of ["", "[bot]"]) expect((await readGate1Creator(answer(ctx({ state: "SUCCESS", creator: { __typename: "Bot", login: "" } })), repo, ourLogin)).ours).toBe(false);
  });

  it("no fx-gate1 on the commit (no status at all, or no such context): state null, not ours", async () => {
    expect(await readGate1Creator(answer(ctx(undefined)), repo, "fx-cloud-app")).toEqual({ state: null, ours: false });
    expect(await readGate1Creator(answer(ctx(null)), repo, "fx-cloud-app")).toEqual({ state: null, ours: false });
  });

  it("a failed read, a GraphQL error, an unknown commit or an answer for another commit is a throw", async () => {
    const bad = [answer(ctx({ state: "SUCCESS" }), 502), answer({ ...ctx({ state: "SUCCESS" }), errors: [{ message: "x" }] }), answer({ data: { repository: { object: null } } }), answer({ data: { repository: null } }), answer(ctx({ state: "SUCCESS" }, "d".repeat(40)))];
    for (const http of bad) await expect(readGate1Creator(http, repo, "fx-cloud-app")).rejects.toThrow(/gate1 creator/);
  });
});
