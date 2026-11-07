import type { LocalGitHubHttp } from "../build/githubMergePort.js";
import { isOurBot } from "./gate1Attest.js";

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
