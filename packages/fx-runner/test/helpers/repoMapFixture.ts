import { readFileSync } from "node:fs";
import path from "node:path";
import { manifestCandidates, readManifest, type Manifest, type RepoMapEntry } from "../../src/job/repoMap.js";
import { PACKAGE_DIR } from "./srcFiles.js";

/**
 * D#600 CX-3b, acceptance 1: the runner's map and the cloud's map are the same bytes for the same tree. `repoMapShared.json` is the one fixture
 * both sides build from: the cloud's pipeline tests (packages/pipeline/test/prompt/repoMapShared.test.ts) read this same file and must reach
 * the same sha256, so a change to either builder that moves a byte fails the other side's test.
 */
export interface SharedFixture {
  commit: string;
  entries: RepoMapEntry[];
  blobs: Record<string, string>;
  expected: { sha256: string; bytes: number; text: string };
  large: { commit: string; count: number; expected: { sha256: string; bytes: number } };
  /** Small trees pinning the limits (MAX_SCRIPTS at and over, MAX_PATH_BYTES at and over) and the manifest-path filter. */
  cases: Array<{ name: string; commit: string; entries: RepoMapEntry[]; blobs: Record<string, string>; expected: { sha256: string; bytes: number; text: string } }>;
}
export const SHARED: SharedFixture = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "test", "fixtures", "repoMapShared.json"), "utf8"));

/** The manifests the way both sides pick and read them from a listing and a blob lookup. */
export function manifestsOf(entries: readonly RepoMapEntry[], blobs: Record<string, string>): Manifest[] {
  const out: Manifest[] = [];
  for (const candidate of manifestCandidates(entries)) {
    const manifest = readManifest(candidate.path, blobs[candidate.sha] ?? "");
    if (manifest) out.push(manifest);
  }
  return out;
}

/** The large tree both sides generate: the same paths in the same order. */
export function largeTree(count: number): RepoMapEntry[] {
  return Array.from({ length: count }, (_, i) => ({ path: `area${i % 50}/pkg${i % 40}/src/file-${i}.ts`, type: "blob" as const, sha: "" }));
}

