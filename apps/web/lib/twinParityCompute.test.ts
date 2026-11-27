import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwinParityJob } from "@fx/core/src/repos/twinSweep.js";
import { setInstallationHttpForTests } from "./github/installationHttp";
import { computeTwinParityForJob } from "./twinParityCompute";

/**
 * D#845 ON-27d4b: the twin's parity adapter opens one read-only `plane_parity` client per repository (the private repo's installation, then the public repo's own row), hands both to the pipeline's check with the twin's stored anchors
 * and always closes both. A client that cannot be opened is `unavailable` (the sweep then stores nothing), and what was opened is still closed.
 */
const SHA = (c: string): string => c.repeat(40);
const JOB: TwinParityJob = {
  accountId: "a", twinId: "t", privateRepoId: "repo-private", publicRepoId: "repo-public", privateRepo: { owner: "acme", name: "hidden" }, publicRepo: { owner: "acme", name: "shown" },
  publishedPrivateSha: SHA("c"), syncedPublicSha: SHA("d"), overlayGlobs: [], installPaths: [],
};
afterEach(() => setInstallationHttpForTests());

describe("computeTwinParityForJob", () => {
  it("opens a plane_parity client for each repository by its own row, reads through them and closes both", async () => {
    const opened: Array<{ kind: string; target: unknown }> = [];
    const closed: string[] = [];
    const requests: string[] = [];
    setInstallationHttpForTests(async (kind, target) => {
      opened.push({ kind, target });
      return {
        request: vi.fn(async (r: { path: string }) => (requests.push(`${(target as { repoId: string }).repoId} ${r.path}`), { status: 200, body: { default_branch: "other" } })),
        close: async () => void closed.push((target as { repoId: string }).repoId),
      } as never;
    });
    const out = await computeTwinParityForJob(JOB);
    expect(opened).toEqual([
      { kind: "plane_parity", target: { repoId: "repo-private", owner: "acme", name: "hidden" } },
      { kind: "plane_parity", target: { repoId: "repo-public", owner: "acme", name: "shown" } },
    ]);
    expect(requests[0]).toBe("repo-public /repos/acme/shown");
    expect(out.result).toBe("unsupported_branch");
    expect(closed.sort()).toEqual(["repo-private", "repo-public"]);
  });

  it("is unavailable when the second client cannot be opened, and still closes the first", async () => {
    const closed: string[] = [];
    setInstallationHttpForTests(async (_kind, target) => {
      if ((target as { repoId: string }).repoId === "repo-public") throw new Error("no installation for https://secret.example");
      return { request: vi.fn(), close: async () => void closed.push("private") } as never;
    });
    const out = await computeTwinParityForJob(JOB);
    expect(out).toMatchObject({ result: "unavailable", privateSha: null, publicSha: null, paths: [] });
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(closed).toEqual(["private"]);
  });
});
