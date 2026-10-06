import { describe, expect, it } from "vitest";
import { createGithubRepoVisibility, type RepoReadHttp } from "../src/targets/githubRepoVisibility.js";

const REPO = { accountId: "acct", repoId: "repo" };

function port(reply: () => Promise<{ status: number; body: unknown }>, coordinates: { owner: string; name: string } | null = { owner: "Acme", name: "widgets" }) {
  const requests: string[] = [];
  const http: RepoReadHttp = { request: async (req) => { requests.push(`${req.method} ${req.path}`); return reply(); } };
  return { requests, port: createGithubRepoVisibility({ resolveRepo: async () => coordinates, open: async () => http }) };
}
const ok = (body: unknown) => async () => ({ status: 200, body });

describe("the GitHub RepoVisibilityPort", () => {
  it("private: true on a 200 for the repo we asked about reads as private, with one GET of the repo", async () => {
    const p = port(ok({ full_name: "acme/Widgets", private: true }));
    expect(await p.port.visibility(REPO)).toBe("private");
    expect(p.requests).toEqual(["GET /repos/Acme/widgets"]);
  });

  it("private: false reads as public", async () => {
    expect(await port(ok({ full_name: "Acme/widgets", private: false })).port.visibility(REPO)).toBe("public");
  });

  it("is live: every call asks GitHub again, so a repo made public a moment ago is seen", async () => {
    let isPrivate = true;
    const p = port(async () => ({ status: 200, body: { full_name: "Acme/widgets", private: isPrivate } }));
    expect(await p.port.visibility(REPO)).toBe("private");
    isPrivate = false;
    expect(await p.port.visibility(REPO)).toBe("public");
    expect(p.requests).toHaveLength(2);
  });

  it.each([
    ["a 403", async () => ({ status: 403, body: { private: true } })],
    ["a 404", async () => ({ status: 404, body: { message: "Not Found" } })],
    ["a 500", async () => ({ status: 500, body: null })],
    ["a 301 redirect", async () => ({ status: 301, body: { full_name: "Acme/widgets", private: true } })],
    ["a transport error", async () => { throw new Error("socket hang up"); }],
    ["a non-object body", ok("private")],
    ["an array body", ok([{ private: true }])],
    ["a null body", ok(null)],
    ["a missing flag", ok({ full_name: "Acme/widgets" })],
    ["the string 'true'", ok({ full_name: "Acme/widgets", private: "true" })],
    ["the number 1", ok({ full_name: "Acme/widgets", private: 1 })],
    ["null", ok({ full_name: "Acme/widgets", private: null })],
    ["a body for another repository", ok({ full_name: "evil/widgets", private: true })],
    ["a body with no name", ok({ private: true })],
  ])("%s reads as unknown, never as private", async (_label, reply) => {
    expect(await port(reply).port.visibility(REPO)).toBe("unknown");
  });

  it("a repo with no GitHub coordinates reads as unknown without any GitHub call", async () => {
    const p = port(ok({ full_name: "Acme/widgets", private: true }), null);
    expect(await p.port.visibility(REPO)).toBe("unknown");
    expect(p.requests).toEqual([]);
  });

  it("no client for the repo (no installation) or a failing lookup reads as unknown", async () => {
    const noClient = createGithubRepoVisibility({ resolveRepo: async () => ({ owner: "a", name: "b" }), open: async () => { throw new Error("no_installation"); } });
    expect(await noClient.visibility(REPO)).toBe("unknown");
    const noLookup = createGithubRepoVisibility({ resolveRepo: async () => { throw new Error("db down"); }, open: async () => ({ request: async () => ({ status: 200, body: {} }) }) });
    expect(await noLookup.visibility(REPO)).toBe("unknown");
  });
});
