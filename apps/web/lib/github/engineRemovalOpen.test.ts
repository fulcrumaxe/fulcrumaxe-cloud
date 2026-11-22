import { describe, expect, it, vi } from "vitest";
import { LocalOnlyGithubError } from "@fx/runner-cloud";
import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "@fx/github";
import { openForEngineRemoval } from "./localOnlyHttp";

/** D#845 ON-16b: the removal client is the merge-gate installation client behind the engineRemove fence, with the merge left out. */
describe("openForEngineRemoval", () => {
  it("opens the merge_gate kind, lets the removal's calls through, and refuses the merge and every delete before a request is made", async () => {
    const sent: string[] = [];
    const opened: Array<[InstallationHttpKind, InstallationHttpTarget]> = [];
    const http = { request: vi.fn(async (req: { method: string; path: string }) => (sent.push(`${req.method} ${req.path}`), { status: 200, body: {} })) } as unknown as InstallationHttp;
    const client = await openForEngineRemoval(async (kind, target) => (opened.push([kind, target]), http), { repoId: "r1", owner: "acme", name: "app" });
    expect(opened.map(([k]) => k)).toEqual(["merge_gate"]);

    await client.request({ method: "GET", path: "/repos/acme/app/pulls/7" });
    expect(sent).toEqual(["GET /repos/acme/app/pulls/7"]);

    const S = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
    for (const req of [
      { method: "PUT" as const, path: "/repos/acme/app/pulls/7/merge", body: { sha: S, merge_method: "squash" } },
      { method: "DELETE" as never, path: "/repos/acme/app" },
      { method: "DELETE" as never, path: "/repos/acme/app/git/refs/heads/fx/engine-remove-1.2.3" },
      { method: "POST" as const, path: `/repos/acme/app/statuses/${S}`, body: { state: "success", context: "fulcrumaxe/review", description: "x" } },
    ]) await expect(client.request(req)).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(sent).toHaveLength(1);
  });
});
