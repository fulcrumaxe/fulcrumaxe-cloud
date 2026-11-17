import { describe, expect, it } from "vitest";
import { EngineAllowedRepo, EngineCommandsPullReply } from "../src/index.js";

/** EB-8a: the pull reply names every repo the runner may bridge, by GitHub id and `owner/name`. The field is optional so a reply without it still parses. */
describe("engine pull reply: allowed_repos", () => {
  const base = { commands: [], controls: [] };

  it("takes a list of repos with their GitHub ids and names, and is optional", () => {
    expect(EngineCommandsPullReply.parse(base)).toEqual(base);
    const reply = { ...base, allowed_repos: [{ repo_gh_id: 42, full_name: "acme/widgets" }, { repo_gh_id: 43, full_name: "acme/a.b_c-d" }] };
    expect(EngineCommandsPullReply.parse(reply)).toEqual(reply);
  });

  it.each([
    [{ repo_gh_id: 0, full_name: "acme/w" }],
    [{ repo_gh_id: 1.5, full_name: "acme/w" }],
    [{ repo_gh_id: 1, full_name: "acme" }],
    [{ repo_gh_id: 1, full_name: "acme/w/extra" }],
    [{ repo_gh_id: 1, full_name: "../etc/passwd" }],
    [{ repo_gh_id: 1, full_name: "acme/w x" }],
    [{ repo_gh_id: 1, full_name: "acme/w", extra: true }],
    [{ repo_gh_id: 1 }],
  ])("refuses %j", (repo) => {
    expect(EngineAllowedRepo.safeParse(repo).success).toBe(false);
    expect(EngineCommandsPullReply.safeParse({ ...base, allowed_repos: [repo] }).success).toBe(false);
  });

  it("holds at most 100 repos and refuses any other key on the reply", () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ repo_gh_id: i + 1, full_name: `acme/r${i}` }));
    expect(EngineCommandsPullReply.safeParse({ ...base, allowed_repos: many }).success).toBe(false);
    expect(EngineCommandsPullReply.safeParse({ ...base, allowed_repos: many.slice(0, 100) }).success).toBe(true);
    expect(EngineCommandsPullReply.safeParse({ ...base, repos: [] }).success).toBe(false);
  });
});
