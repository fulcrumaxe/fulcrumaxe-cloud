import type { Git } from "./git.js";
import { REPO_MAP_BLOB_MAX_BYTES, REPO_MAP_VERSION, buildRepoMap, manifestCandidates, readManifest, type Manifest, type RepoMapEntry } from "../job/repoMap.js";

/**
 * D#600 CX-3b: reads a commit's file tree out of the repo's bare mirror (nothing leaves the machine, no network) and builds the repository
 * map from it, with the same builder the cloud uses for a hosted run. Only git's own object reads are used: `ls-tree` for the listing and
 * `cat-file` for each package manifest. No file of the workspace is opened, so what the agent has written there cannot change the map.
 *
 * Every failure is `null` (the run starts without a map): a map is never a reason to refuse or delay a run. The caller records a closed
 * word, never git's output.
 */
const SHA = /^[0-9a-f]{40}$/;
/** What the large capture keeps of a listing (8 MiB). A listing that long may have been cut, so the map says so with its marker. */
export const LISTING_CAP = 8 * 1024 * 1024;
/** The whole map build (the listing and every manifest read together) gets this long. Past it the git children are killed and the run starts with no map. */
export const MAP_DEADLINE_MS = 30_000;
const RECORD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]+)$/;

export interface MapGits {
  /** Reads the tree listing: the large capture (the listing of a big repo is far over 64 K). */
  listing: Git;
  /** Reads one small blob. */
  small: Git;
  /** How much of a listing `listing` keeps (its capture's limit): output that long is taken as cut. */
  listingCap: number;
}

/** `ls-tree -r -t -z` output as entries. Throws on a record that is not git's own shape. A cut listing loses its last (maybe partial) record. */
export function parseListing(output: string, cap: number): { entries: RepoMapEntry[]; truncated: boolean } {
  const cut = output.length >= cap;
  const records = output.split("\0");
  // `-z` ends every record with NUL, so the last piece is empty; on a cut listing it is a partial record instead.
  records.pop();
  const entries: RepoMapEntry[] = [];
  for (const record of records) {
    const m = record.match(RECORD);
    if (m === null) throw new TypeError("listing");
    entries.push({ type: m[2] as RepoMapEntry["type"], sha: m[3]!, path: m[4]! });
  }
  return { entries, truncated: cut };
}

export async function readRepoMap(gits: MapGits, mirrorDir: string, sha: string, options: { deadlineMs?: number; now?: () => number } = {}): Promise<{ version: string; text: string } | null> {
  if (!SHA.test(sha)) return null;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? MAP_DEADLINE_MS);
  // Every git call gets only what is left of the one deadline as its own time limit, so the capture kills a stalled child (SIGKILL) when it runs
  // out and the total across all calls cannot pass the deadline. Nothing left is a failure like any other: no map.
  const left = (): number => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new TypeError("deadline");
    return remaining;
  };
  try {
    const { entries, truncated } = parseListing(await gits.listing.run("mirror_failed", ["-C", mirrorDir, "ls-tree", "-r", "-t", "-z", sha], undefined, left()), gits.listingCap);
    const manifests: Manifest[] = [];
    for (const candidate of manifestCandidates(entries)) {
      const size = Number.parseInt((await gits.small.run("mirror_failed", ["-C", mirrorDir, "cat-file", "-s", candidate.sha], undefined, left())).trim(), 10);
      if (!Number.isSafeInteger(size) || size > REPO_MAP_BLOB_MAX_BYTES) continue;
      const text = await gits.small.run("mirror_failed", ["-C", mirrorDir, "cat-file", "blob", candidate.sha], undefined, left());
      // The capture decodes leniently; a blob that is not UTF-8 text shows as U+FFFD, and reads as "no manifest here" (as on the cloud side).
      if (text.includes("�")) continue;
      const manifest = readManifest(candidate.path, text);
      if (manifest) manifests.push(manifest);
    }
    return { version: REPO_MAP_VERSION, text: buildRepoMap({ sha, paths: entries, truncated, manifests }) };
  } catch {
    // fx-swallow-ok: a map that cannot be built is left out of the prompt; the caller records a fixed word, and git's output (it can hold a path) is dropped
    return null;
  }
}
