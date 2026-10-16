import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_MAP_MAX_BYTES, REPO_MAP_TRUNCATED_MARKER, buildRepoMap, createRepoMapPort, type RepoMapCache, type RepoMapSource } from "../../src/prompt/repoMap.js";

/**
 * D#600 CX-3b, acceptance 1, the cloud's half: the map the cloud builds from GitHub's listing of a tree is the one the runner builds from its
 * mirror. Both sides read ONE fixture file, the runner package's `repoMapShared.json`, and must reach the sha256 recorded in it; a change to
 * either builder that moves a byte fails the other side's test. (The runner's half: packages/fx-runner/test/job/repoMap.test.ts.)
 */
interface Entry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}
const FIXTURE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fx-runner/test/fixtures/repoMapShared.json");
const SHARED = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as {
  commit: string;
  entries: Entry[];
  blobs: Record<string, string>;
  expected: { sha256: string; bytes: number; text: string };
  large: { commit: string; count: number; expected: { sha256: string; bytes: number } };
  cases: Array<{ name: string; commit: string; entries: Entry[]; blobs: Record<string, string>; expected: { sha256: string; bytes: number; text: string } }>;
};
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** GitHub's side, as the trees API gives it. */
const sourceFor = (head: string, entries: Entry[], blobs: Record<string, string>): RepoMapSource => ({
  headSha: async () => head,
  tree: async () => ({ truncated: false, entries }),
  blob: async (sha) => blobs[sha] ?? null,
});
class Memory implements RepoMapCache {
  text: string | null = null;
  async get() {
    return null;
  }
  async put(_key: unknown, text: string) {
    this.text = text;
  }
}
const REQ = { accountId: "acct", repoId: "repo", owner: "acme", name: "widgets" };

describe("the repository map is the same on the cloud and on the runner (D#600 CX-3b)", () => {
  it("the shared tree, through the cloud's port (its manifest picking and reads included), is the fixture's text and sha256", async () => {
    const cache = new Memory();
    const out = await createRepoMapPort({ open: async () => sourceFor(SHARED.commit, SHARED.entries, SHARED.blobs), cache }).forRun(REQ);
    expect(out!.text).toBe(SHARED.expected.text);
    expect(sha256(out!.text)).toBe(SHARED.expected.sha256);
    expect(Buffer.byteLength(out!.text, "utf8")).toBe(SHARED.expected.bytes);
    // What the cache stores (and hashes into `body_sha256`) is that same text.
    expect(cache.text).toBe(SHARED.expected.text);
  });

  it("each limit case (scripts at and over the limit, paths at and over 200 bytes, manifest paths with a newline or a control character) is the fixture's text and sha256", async () => {
    expect(SHARED.cases.length).toBeGreaterThanOrEqual(7);
    for (const c of SHARED.cases) {
      const out = await createRepoMapPort({ open: async () => sourceFor(c.commit, c.entries, c.blobs), cache: new Memory() }).forRun(REQ);
      expect(out!.text, c.name).toBe(c.expected.text);
      expect({ bytes: Buffer.byteLength(out!.text, "utf8"), sha256: sha256(out!.text) }, c.name).toEqual({ bytes: c.expected.bytes, sha256: c.expected.sha256 });
    }
  });

  it("60,000 paths: at most 8 KiB, the truncation marker, and the sha256 the runner's test asserts", () => {
    const paths: Entry[] = Array.from({ length: SHARED.large.count }, (_, i) => ({ path: `area${i % 50}/pkg${i % 40}/src/file-${i}.ts`, type: "blob" as const, sha: "" }));
    const text = buildRepoMap({ sha: SHARED.large.commit, paths, truncated: false, manifests: [] });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(REPO_MAP_MAX_BYTES);
    expect(text.endsWith(`\n${REPO_MAP_TRUNCATED_MARKER}`)).toBe(true);
    expect({ bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) }).toEqual(SHARED.large.expected);
  });
});
