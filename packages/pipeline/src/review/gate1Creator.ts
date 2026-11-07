import { isLocalGitHubHttp, type GitHubHttp, type LocalGitHubHttp } from "../build/githubMergePort.js";
import { GATE1_CONTEXT, isOurBot } from "./gate1Attest.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1c: who posted the newest `fx-gate1` on one commit, read through the fence's A17 (`Gate1Status`) and nothing else. The merge
 * gate uses it so that, for a cloud item, an `fx-gate1` counts only when our App's bot posted it.
 *
 * GitHub's own record decides, never text a pull request controls. GraphQL names an App's bot by its slug (REST adds `[bot]`), and the type must be `Bot`:
 * a user account, an organisation or a lookalike login never passes. Logins are compared exactly (GitHub stores an App's slug in lower case).
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (what: string): never => {
  throw new Error(`gate1 creator: ${what}`);
};

export interface Gate1Creator {
  /** GitHub's upper-case state of the newest `fx-gate1` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED), or null when the commit has none. */
  state: string | null;
  /** The poster is our App's bot. */
  ours: boolean;
}

/** A read that fails, a GraphQL error or an answer for another commit is a throw, never "none" or "ours". */
export async function readGate1Creator(http: LocalGitHubHttp, repo: { owner: string; name: string; sha: string }, ourLogin: string): Promise<Gate1Creator> {
  const res = await http.graphql("Gate1Status", { owner: repo.owner, name: repo.name, sha: repo.sha });
  if (res.status !== 200 || !isObj(res.body) || res.body.errors !== undefined || !isObj(res.body.data) || !isObj(res.body.data.repository)) return fail("unreadable");
  const commit = isObj(res.body.data.repository.object) ? res.body.data.repository.object : fail("commit");
  if (commit.oid !== repo.sha) fail("oid");
  const ctx = isObj(commit.status) ? commit.status.context : null;
  if (!isObj(ctx)) return { state: null, ours: false };
  // The attester's own rule (`isOurBot`), and never for an empty login of ours.
  const ours = ourLogin.replace(/\[bot\]$/, "").length > 0 && isOurBot(ctx.creator, ourLogin);
  return { state: typeof ctx.state === "string" ? ctx.state : null, ours };
}

/** REST pages of `commits/{sha}/statuses` read before the answer is unknown (a throw, never "none"). */
const REST_STATUS_PAGES = 5;
const REST_PER_PAGE = 100;
const SHA = /^[0-9a-f]{40}$/;

/**
 * PR 1e: the same answer for a hosted pair, through the plain `merge_gate` client's REST read `commits/{sha}/statuses`, which GitHub lists newest first:
 * the first `fx-gate1` there is the context's current state. REST names the creator `{ login, type }`, an App's bot as `<slug>[bot]` typed `Bot`; the same
 * `isOurBot` rule decides. The state is given upper case, as GraphQL gives it. A list that ends without `fx-gate1` has none; one that runs past the pages
 * read without it is a throw (unknown).
 */
export async function readGate1CreatorRest(http: GitHubHttp, repo: { owner: string; name: string; sha: string }, ourLogin: string): Promise<Gate1Creator> {
  if (!SHA.test(repo.sha)) fail("sha");
  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${repo.sha}/statuses`;
  for (let page = 1; page <= REST_STATUS_PAGES; page++) {
    const res = await http.request({ method: "GET", path, query: { per_page: REST_PER_PAGE, page } });
    if (res.status !== 200 || !Array.isArray(res.body)) return fail("unreadable");
    const list = res.body as unknown[];
    for (const s of list) {
      if (!isObj(s) || typeof s.context !== "string") return fail("status entry");
      if (s.context !== GATE1_CONTEXT) continue;
      if (typeof s.state !== "string") return fail("status state");
      const c = isObj(s.creator) ? s.creator : null;
      const ours = ourLogin.replace(/\[bot\]$/, "").length > 0 && c !== null && isOurBot({ __typename: c.type, login: c.login }, ourLogin);
      return { state: s.state.toUpperCase(), ours };
    }
    if (list.length < REST_PER_PAGE) return { state: null, ours: false };
  }
  return fail("statuses beyond the pages read");
}

/** The reader for a client: A17 on a fenced (`runner_local`) client, REST on the hosted `merge_gate` client. */
export const readGate1CreatorFor = (http: GitHubHttp, repo: { owner: string; name: string; sha: string }, ourLogin: string): Promise<Gate1Creator> =>
  isLocalGitHubHttp(http) ? readGate1Creator(http, repo, ourLogin) : readGate1CreatorRest(http, repo, ourLogin);
