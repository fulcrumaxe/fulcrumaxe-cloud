#!/usr/bin/env node
// Merge queue shortcut: decides whether a merge-group run may skip the heavy suites because the exact tree it
// would test has already passed a green full-scope run.
//
//   node scripts/ci/same-tree.mjs
//
// Inputs arrive through the environment as data (set by ci.yml from the event, never spliced into a script):
//   CI_EVENT_NAME     github.event_name
//   MG_HEAD_REF       github.event.merge_group.head_ref   (refs/heads/gh-readonly-queue/<base>/pr-<N>-<base sha>)
//   MG_HEAD_SHA       github.event.merge_group.head_sha
//   MG_BASE_SHA       github.event.merge_group.base_sha   (the base branch tip the group was built on)
//   GITHUB_REPOSITORY owner/name
//   GH_TOKEN          the workflow's read-only token
//   FX_APP_BOT_LOGIN  login (slug) of our App's bot, the only poster of `fx-gate1` that counts
//
// The answer is `true` only when ALL of these hold; any doubt, or any API error, answers `false` and the job
// runs its suites in full, exactly as it did before this script existed:
//   1. the event is a merge group, and its head ref names exactly ONE pull request whose recorded base sha
//      equals the group's base sha;
//   2. the checked-out commit is the group's head commit and its first parent is that base sha (a group of
//      several pull requests builds each commit on the previous one, so the second and later commits fail this);
//   3. the pull request's current head commit has a tree byte-identical to the checked-out commit's tree (so
//      the base branch had not moved since the head was built on it);
//   4. that head commit carries `fx-gate1` = success posted by our App's bot. That status is posted only after
//      the five required contexts (check, e2e-runner, workspace-e2e desktop/phone/tablet) were green in a
//      full-scope run for that exact sha (packages/pipeline/src/review/gate1Attest.ts), which is the proof.
// On `true` it appends CI_SAME_TREE=true to $GITHUB_ENV; the heavy steps are guarded on that. It never fails the
// job: the exit status is 0 whatever the answer.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REF_RE = /^refs\/heads\/gh-readonly-queue\/[^/]+\/pr-(\d+)-([0-9a-f]{40})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const GATE1_CONTEXT = "fx-gate1";
const MAX_STATUS_PAGES = 10;
const PER_PAGE = 100;

/** Same rule as isOurBot in gate1Attest.ts: the App slug, with or without `[bot]`, typed Bot; nothing by prefix. */
export function isOurBot(creator, ourLogin) {
  if (!creator || typeof creator !== "object" || creator.type !== "Bot" || typeof creator.login !== "string") return false;
  if (typeof ourLogin !== "string" || ourLogin === "") return false;
  const slug = ourLogin.replace(/\[bot\]$/, "");
  if (slug === "") return false;
  return creator.login === slug || creator.login === `${slug}[bot]`;
}

/**
 * @param {{ env: Record<string,string|undefined>, git: (args: string[]) => string, getJson: (path: string) => Promise<unknown> }} io
 * @returns {Promise<{ proven: boolean, reason: string }>}
 */
export async function decide({ env, git, getJson }) {
  const no = (reason) => ({ proven: false, reason });
  try {
    if (env.CI_EVENT_NAME !== "merge_group") return no("not a merge group run");
    const m = REF_RE.exec(env.MG_HEAD_REF ?? "");
    if (!m) return no("merge group head ref does not name exactly one pull request");
    const pr = Number(m[1]);
    const refBase = m[2];
    const headSha = env.MG_HEAD_SHA ?? "";
    const baseSha = env.MG_BASE_SHA ?? "";
    if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) return no("merge group shas missing");
    if (!Number.isSafeInteger(pr) || pr <= 0) return no("bad pull request number");
    if (refBase !== baseSha) return no("merge group is not built directly on the base tip (more than one pull request, or the ref and event disagree)");
    if (git(["rev-parse", "HEAD"]).trim() !== headSha) return no("checked-out commit is not the merge group head");
    if (git(["rev-parse", "HEAD^1"]).trim() !== baseSha) return no("merge group commit is not directly on the base tip");
    const myTree = git(["rev-parse", "HEAD^{tree}"]).trim();
    if (!SHA_RE.test(myTree)) return no("could not read the checked-out tree");

    const repo = env.GITHUB_REPOSITORY ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return no("repository unknown");
    const base = `/repos/${repo}`;

    const prBody = await getJson(`${base}/pulls/${pr}`);
    const prHead = prBody && typeof prBody === "object" ? prBody.head : null;
    const prSha = prHead && typeof prHead === "object" ? prHead.sha : null;
    if (typeof prSha !== "string" || !SHA_RE.test(prSha)) return no("pull request head unreadable");

    const commit = await getJson(`${base}/git/commits/${prSha}`);
    const prTree = commit && typeof commit === "object" && commit.tree && typeof commit.tree === "object" ? commit.tree.sha : null;
    if (typeof prTree !== "string" || !SHA_RE.test(prTree)) return no("pull request head tree unreadable");
    // pull_request CI tests GitHub's merge of the head onto main AS IT WAS then. Only when the head sits directly
    // on the group's base (one parent, equal to the base tip) was main that same commit then, so the merge it
    // tested had exactly the head's tree. Without this, a tree equal to the head's could come from a revert.
    const parents = commit && typeof commit === "object" ? commit.parents : null;
    if (!Array.isArray(parents) || parents.length !== 1 || !parents[0] || parents[0].sha !== baseSha) return no("pull request head is not built directly on the base tip (one parent equal to the group base is required)");
    if (prTree !== myTree) return no("trees differ (the base branch moved, or the queue changed the content)");

    if (!env.FX_APP_BOT_LOGIN) return no("no App login configured");
    for (let page = 1; page <= MAX_STATUS_PAGES; page++) {
      const list = await getJson(`${base}/commits/${prSha}/statuses?per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(list)) return no("statuses unreadable");
      for (const s of list) {
        if (!s || typeof s !== "object" || typeof s.context !== "string") return no("statuses entry unreadable");
        if (s.context !== GATE1_CONTEXT) continue;
        // Newest first: the first fx-gate1 is the context's current state.
        return s.state === "success" && isOurBot(s.creator, env.FX_APP_BOT_LOGIN)
          ? { proven: true, reason: `tree ${myTree} equals the head of pull request ${pr} (${prSha}), which carries fx-gate1 = success from our App` }
          : no("fx-gate1 on the pull request head is not a success posted by our App");
      }
      if (list.length < PER_PAGE) return no("no fx-gate1 status on the pull request head");
    }
    return no("fx-gate1 not found within the pages read");
  } catch (e) {
    return no(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The lines appended to $GITHUB_ENV on a proven answer: CI_SAME_TREE=true, plus the one extra constant
 * assignment the workflow names in SAME_TREE_ALSO_SET (workspace-e2e uses it to switch its own scope flag off).
 * Only `NAME=lowercase-word` is accepted, so the value can never inject anything else.
 */
export function envLines(also) {
  let out = "CI_SAME_TREE=true\n";
  if (typeof also === "string" && /^[A-Z][A-Z0-9_]*=[a-z]+$/.test(also)) out += `${also}\n`;
  return out;
}

async function main() {
  const gitRun = (args) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
    return r.stdout;
  };
  const apiRoot = process.env.GITHUB_API_URL || "https://api.github.com";
  const getJson = async (path) => {
    const r = await fetch(apiRoot + path, {
      headers: { authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, accept: "application/vnd.github+json", "user-agent": "ci-same-tree" },
    });
    if (!r.ok) throw new Error(`GET ${path.split("?")[0].split("/").slice(-1)[0]} answered ${r.status}`);
    return r.json();
  };
  const { proven, reason } = await decide({ env: process.env, git: gitRun, getJson });
  const line = proven
    ? `CI scope: same tree already proven (${reason}); the suites are skipped in this merge queue run`
    : `CI scope: same tree not proven (${reason}); running in full`;
  console.log(`same_tree_proven=${proven}`);
  console.log(line);
  try {
    if (proven && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, envLines(process.env.SAME_TREE_ALSO_SET));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
  } catch {
    // A failed write leaves the answer at "not proven": the suites run.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log("same_tree_proven=false");
    console.log(`CI scope: same tree not proven (error: ${e instanceof Error ? e.message : String(e)}); running in full`);
  });
}
