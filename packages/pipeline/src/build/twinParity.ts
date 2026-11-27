import { twinPrivateOverlay } from "@fulcrumaxe/runner-protocol";
import { compileOverlay, diffTreeEntries, type TreeEntry } from "@fulcrumaxe/runner-protocol/planePush";
import type { GitHubHttp } from "./githubMergePort.js";
import { Stop, parityReads, type PlaneParityRepo } from "./planeParity.js";

/**
 * A private twin and its public repository: where do the two stand? (D#845 ON-27d1, Ruling 89 4.5. Nothing calls this yet: the twin routes answer 503 until the kill switch turns on.)
 *
 * D#598's `computePlaneParity` reads git ancestry, and a twin's publish pull requests are SQUASH-merged, so private main never contains public main's commits. The twin anchors on two shas it stores instead: the private commit the
 * last publish carried (`published_private_sha`) and the public tip the last sync carried (`synced_public_sha`). It reuses planeParity's bounded reads (`parityReads`: the same call, per-call and overall caps) and
 * `diffTreeEntries`, reads metadata only (tips and recursive trees, no file content, no commit list) and drops the twin's private set from both sides.
 *
 *   P = private main's tree minus the private set        U = public main's tree minus the private set
 *   private delta = private@published against P            public delta = public@synced against U
 *
 * Every path where P and U differ is one of: published by the private side only (`publish_pending`), changed by the public side only (`sync_pending`), or changed on BOTH sides since the last anchors (`conflict`). A path that
 * differs yet is in neither delta cannot happen when the anchors are right; it is treated as a conflict, never as a sync, so a wrong anchor pauses a path and never overwrites a private file with a public one.
 * A path in the public delta whose public blob already equals the private one was our own publish merging: it is a no-op, and when nothing else is left to bring in the caller moves `synced_public_sha` to `advanceSyncedTo`.
 * A result with paths holds the paths of its own kind only (sorted, at most 200), and the three counts are exact. Bounds: 8 reads of at most 10, 10 s each, 25 s in all. Nothing is logged, and a result holds paths, never a login,
 * a message of GitHub's or a token. Writing the result and the anchor is the caller's (a definer of a later migration); this function only reads.
 */
export type TwinParityResult = "in_parity" | "publish_pending" | "sync_pending" | "conflict" | "invalid_overlay" | "too_large" | "unsupported_branch" | "unavailable";

export interface TwinParityInput {
  /** Both clients are the read-only `plane_parity` installation kind, one per repository. */
  privateHttp: GitHubHttp;
  publicHttp: GitHubHttp;
  twin: {
    privateRepo: PlaneParityRepo;
    publicRepo: PlaneParityRepo;
    publishedPrivateSha: string | null;
    syncedPublicSha: string | null;
    overlayGlobs: readonly string[];
    installPaths: readonly string[];
  };
  /** The whole check must end by this time (ms since the epoch); the default is 25 s from the start. */
  deadline?: number;
  now?: () => number;
  /** For tests only. */
  limits?: { maxCalls?: number; callTimeoutMs?: number };
}

export interface TwinParityOutcome {
  result: TwinParityResult;
  privateSha: string | null;
  publicSha: string | null;
  /** The paths of the result's own kind (the conflicting paths for `conflict`, and so on), sorted, at most TWIN_PARITY_PATHS_CAP. */
  paths: string[];
  /** How many paths the result is about, not capped. */
  pathCount: number;
  publishCount: number;
  syncCount: number;
  conflictCount: number;
  /** The public tip `synced_public_sha` may move to without a sync (nothing public is left to bring in and nothing conflicts), else null. */
  advanceSyncedTo: string | null;
  /** For `too_large` and `unsupported_branch`: which repository it is about. */
  limitSide: "private" | "public" | null;
}

export const TWIN_PARITY_PATHS_CAP = 200;
const SHA40 = /^[0-9a-f]{40}$/;

export async function computeTwinParity(input: TwinParityInput): Promise<TwinParityOutcome> {
  const out: TwinParityOutcome = { result: "unavailable", privateSha: null, publicSha: null, paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null, limitSide: null };
  const { twin } = input;
  const overlay = compileOverlay(twinPrivateOverlay({ overlayGlobs: twin.overlayGlobs, installPaths: twin.installPaths }));
  if ("error" in overlay) return { ...out, result: "invalid_overlay" };
  // A twin that has not been seeded has no anchors to compare against.
  if (twin.publishedPrivateSha === null || twin.syncedPublicSha === null || !SHA40.test(twin.publishedPrivateSha) || !SHA40.test(twin.syncedPublicSha)) return out;
  const { tipOf, readTree } = parityReads(input);
  const keep = (path: string): boolean => !overlay.match(path);
  try {
    const u = await tipOf(input.publicHttp, twin.publicRepo, "public");
    const p = await tipOf(input.privateHttp, twin.privateRepo, "private");
    out.publicSha = u;
    out.privateSha = p;
    const trees = new Map<string, Map<string, TreeEntry>>();
    const read = async (side: "private" | "public", sha: string): Promise<Map<string, TreeEntry>> => {
      const key = `${side}:${sha}`;
      const have = trees.get(key);
      if (have !== undefined) return have;
      const tree = await readTree(side === "private" ? input.privateHttp : input.publicHttp, side === "private" ? twin.privateRepo : twin.publicRepo, sha, side);
      trees.set(key, tree);
      return tree;
    };
    const privTip = await read("private", p);
    const pubTip = await read("public", u);
    const privDelta = new Set(diffTreeEntries(await read("private", twin.publishedPrivateSha), privTip, keep).paths);
    const pubDelta = new Set(diffTreeEntries(await read("public", twin.syncedPublicSha), pubTip, keep).paths);
    const publish: string[] = [];
    const sync: string[] = [];
    const conflict: string[] = [];
    for (const path of diffTreeEntries(privTip, pubTip, keep).paths) {
      const priv = privDelta.has(path);
      const pub = pubDelta.has(path);
      if (priv && !pub) publish.push(path);
      else if (pub && !priv) sync.push(path);
      else conflict.push(path);
    }
    out.publishCount = publish.length;
    out.syncCount = sync.length;
    out.conflictCount = conflict.length;
    // Nothing public is left to bring in and nothing is in dispute: the public tip's changes were all our own publish (or private-set paths), so the anchor can simply move.
    if (sync.length === 0 && conflict.length === 0 && u !== twin.syncedPublicSha) out.advanceSyncedTo = u;
    const [result, paths] = conflict.length > 0 ? (["conflict", conflict] as const) : sync.length > 0 ? (["sync_pending", sync] as const) : publish.length > 0 ? (["publish_pending", publish] as const) : (["in_parity", []] as const);
    out.result = result;
    out.paths = paths.slice().sort().slice(0, TWIN_PARITY_PATHS_CAP);
    out.pathCount = paths.length;
    return out;
  } catch (err) {
    // fx-swallow-ok: a Stop is a result; anything unexpected is "could not know", and its text can carry a path, so it is not kept
    return { ...out, result: err instanceof Stop ? err.result : "unavailable", paths: [], pathCount: 0, publishCount: 0, syncCount: 0, conflictCount: 0, advanceSyncedTo: null, limitSide: err instanceof Stop ? err.side : null };
  }
}
