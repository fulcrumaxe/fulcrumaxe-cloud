import { compileOverlay, diffTreeEntries, treeFromEntries, type TreeEntry } from "@fulcrumaxe/runner-protocol/planePush";
import type { GitHubHttp } from "./githubMergePort.js";

/**
 * Two planes: is private main in step with public main? (D#598 P1d-2, the reads and the rule; nothing calls this yet.)
 *
 * The engine's SYNC rule, not its check rule: private main only takes a public merge when a sync runs, so a check against public main's tip would report
 * lag as drift. `U` and `P` are the two tips, read once and used as explicit commit ids. The sync point `S` is the newest of public main's last 30 commits that
 * private main contains: private main's history is read as commit lists (`commits?sha=P&per_page=100`, at most 2 pages, 200 commits; ids only, no file
 * lists, and never the compare endpoint, whose answer carries diffs), and `S` is the first window commit whose id is in it. With none there is no sync point. Drift is P against S, lag is S before U with no difference, parity is S equal to U. With no
 * sync point P is compared with U (`no_shared_history` when they differ). The overlay (`compileOverlay`, the push's matcher) is dropped from BOTH sides.
 *
 * Bounds: 10 calls, 10 s each, 25 s in all. A recursive tree that is not plainly untruncated is `too_large`; a default branch other than `main` is `unsupported_branch` (a lasting condition, raised like `too_large`); any other failure to know is `unavailable`.
 * No file content is reachable through the client or read here, and nothing is logged: a result holds paths only in `paths`, never a login, a message of GitHub's or a token.
 */
export type PlaneParityResult = "in_parity" | "lag" | "drift" | "no_shared_history" | "too_large" | "invalid_overlay" | "unsupported_branch" | "unavailable";

export interface PlaneParityRepo {
  owner: string;
  name: string;
}
export interface PlaneParityInput {
  /** Both clients are the read-only `plane_parity` installation kind, one per repository. */
  privateHttp: GitHubHttp;
  publicHttp: GitHubHttp;
  pairing: { privateRepo: PlaneParityRepo; publicRepo: PlaneParityRepo; overlayGlobs: readonly string[] };
  /** The whole check must end by this time (ms since the epoch); the default is 25 s from the start. */
  deadline?: number;
  now?: () => number;
  /** For tests only. */
  limits?: { maxCalls?: number; callTimeoutMs?: number };
}
export interface PlaneParityOutcome {
  result: PlaneParityResult;
  privateSha: string | null;
  publicSha: string | null;
  syncSha: string | null;
  /** The differing paths (sorted, at most PATHS_CAP) for `drift` and `no_shared_history`; otherwise empty. */
  paths: string[];
  pathCount: number;
  /** Public paths the overlay matches. Counted, never named. */
  overlayOnPublicCount: number;
  /** For `too_large` and `unsupported_branch`: which repository it is about. */
  limitSide: "private" | "public" | null;
}

export const MAX_PARITY_CALLS = 10;
export const PARITY_CALL_TIMEOUT_MS = 10_000;
export const PARITY_DEADLINE_MS = 25_000;
export const PARITY_WINDOW = 30;
export const PARITY_HISTORY_PER_PAGE = 100;
export const PARITY_HISTORY_PAGES = 2;
const PATHS_CAP = 200;
const BRANCH = "main";
const SHA40 = /^[0-9a-f]{40}$/;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Thrown inside the check to end it with a result; never escapes. */
class Stop extends Error {
  constructor(
    readonly result: "too_large" | "unavailable" | "unsupported_branch",
    readonly side: "private" | "public" | null = null,
  ) {
    super(result);
  }
}

export async function computePlaneParity(input: PlaneParityInput): Promise<PlaneParityOutcome> {
  const now = input.now ?? Date.now;
  const deadline = input.deadline ?? now() + PARITY_DEADLINE_MS;
  const maxCalls = input.limits?.maxCalls ?? MAX_PARITY_CALLS;
  const callTimeoutMs = input.limits?.callTimeoutMs ?? PARITY_CALL_TIMEOUT_MS;
  const out: PlaneParityOutcome = { result: "unavailable", privateSha: null, publicSha: null, syncSha: null, paths: [], pathCount: 0, overlayOnPublicCount: 0, limitSide: null };
  const overlay = compileOverlay(input.pairing.overlayGlobs);
  if ("error" in overlay) return { ...out, result: "invalid_overlay" };

  let calls = 0;
  /** One counted, bounded GET. Every failure to get an answer is `unavailable`. */
  const get = async (http: GitHubHttp, repo: PlaneParityRepo, rest: string, query?: Record<string, string | number>): Promise<{ status: number; body: unknown }> => {
    const left = deadline - now();
    if (calls >= maxCalls || left <= 0) throw new Stop("unavailable");
    calls++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Stop("unavailable")), Math.min(callTimeoutMs, left));
      });
      return await Promise.race([http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}${rest}`, ...(query ? { query } : {}) }), limit]);
    } catch {
      // fx-swallow-ok: a transport failure, a refusal by the read-only client or a timeout all mean "could not know"; their text can carry a URL and is dropped
      throw new Stop("unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const tipOf = async (http: GitHubHttp, repo: PlaneParityRepo, side: "private" | "public"): Promise<string> => {
    const r = await get(http, repo, "");
    if (r.status !== 200 || !isObj(r.body) || typeof r.body.default_branch !== "string") throw new Stop("unavailable");
    // A lasting condition, not an outage: the check only knows `main` (the client's list allows no other ref), so a person is told.
    if (r.body.default_branch !== BRANCH) throw new Stop("unsupported_branch", side);
    const ref = await get(http, repo, `/git/ref/heads/${BRANCH}`);
    const sha = ref.status === 200 && isObj(ref.body) && isObj(ref.body.object) ? ref.body.object.sha : undefined;
    if (typeof sha !== "string" || !SHA40.test(sha)) throw new Stop("unavailable");
    return sha;
  };
  const readTree = async (http: GitHubHttp, repo: PlaneParityRepo, sha: string, side: "private" | "public"): Promise<Map<string, TreeEntry>> => {
    const r = await get(http, repo, `/git/trees/${sha}`, { recursive: "1" });
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.tree)) throw new Stop("unavailable");
    if (r.body.truncated !== false) throw new Stop("too_large", side);
    const tree = treeFromEntries(r.body.tree);
    if (tree === null) throw new Stop("unavailable");
    return tree;
  };
  /** The ids in private main's history, newest first: at most PARITY_HISTORY_PAGES pages of PARITY_HISTORY_PER_PAGE commits (a commit list holds no file data). */
  const privateHistory = async (p: string, wanted: string): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (let page = 1; page <= PARITY_HISTORY_PAGES; page++) {
      const r = await get(input.privateHttp, input.pairing.privateRepo, "/commits", { sha: p, per_page: PARITY_HISTORY_PER_PAGE, page });
      if (r.status !== 200 || !Array.isArray(r.body) || r.body.length > PARITY_HISTORY_PER_PAGE) throw new Stop("unavailable");
      for (const c of r.body) {
        if (!isObj(c) || typeof c.sha !== "string" || !SHA40.test(c.sha)) throw new Stop("unavailable");
        ids.add(c.sha);
      }
      // The newest public commit is already there, or the history ended: no later page can change the answer.
      if (ids.has(wanted) || r.body.length < PARITY_HISTORY_PER_PAGE) break;
    }
    return ids;
  };

  try {
    const pubRepo = input.pairing.publicRepo;
    const privRepo = input.pairing.privateRepo;
    const u = await tipOf(input.publicHttp, pubRepo, "public");
    const p = await tipOf(input.privateHttp, privRepo, "private");
    out.publicSha = u;
    out.privateSha = p;

    const list = await get(input.publicHttp, pubRepo, "/commits", { sha: u, per_page: PARITY_WINDOW });
    if (list.status !== 200 || !Array.isArray(list.body) || list.body.length < 1 || list.body.length > PARITY_WINDOW) throw new Stop("unavailable");
    const window: Array<{ sha: string }> = [];
    for (const c of list.body) {
      if (!isObj(c) || typeof c.sha !== "string" || !SHA40.test(c.sha)) throw new Stop("unavailable");
      window.push({ sha: c.sha });
    }
    if (window[0]!.sha !== u) throw new Stop("unavailable");

    // The sync point is the newest of the window that private main's history contains. Beyond PARITY_HISTORY_PAGES pages it is "no sync point".
    const history = await privateHistory(p, window[0]!.sha);
    const sync = window.find((c) => history.has(c.sha))?.sha ?? null;
    out.syncSha = sync;

    const privTree = await readTree(input.privateHttp, privRepo, p, "private");
    const baseSha = sync ?? u;
    const baseTree = await readTree(input.publicHttp, pubRepo, baseSha, "public");
    const tipTree = baseSha === u ? baseTree : await readTree(input.publicHttp, pubRepo, u, "public");
    for (const path of tipTree.keys()) if (overlay.match(path)) out.overlayOnPublicCount++;

    const differing = diffTreeEntries(baseTree, privTree, (path) => !overlay.match(path)).paths.slice().sort();
    if (differing.length > 0) {
      out.result = sync === null ? "no_shared_history" : "drift";
      out.paths = differing.slice(0, PATHS_CAP);
      out.pathCount = differing.length;
    } else out.result = sync === u || sync === null ? "in_parity" : "lag";
    return out;
  } catch (err) {
    // fx-swallow-ok: a Stop is a result; anything unexpected is "could not know", and its text can carry a path, so it is not kept
    return { ...out, result: err instanceof Stop ? err.result : "unavailable", paths: [], pathCount: 0, limitSide: err instanceof Stop ? err.side : null };
  }
}
