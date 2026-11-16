#!/usr/bin/env node
// Merge queue rollups: one full run per batch instead of one per entry.
//
//   node scripts/ci/rollup-position.mjs
//
// The queue grouping is HEADGREEN: GitHub merges a group when the LAST entry (the one whose commit contains every
// entry ahead of it) passes its required checks. An entry that has another entry on top of it in the queue does
// not need to run the suites itself, if GitHub does not wait for it.
//
// What this never does: report success on the strength of an entry on top that might still be taken away. The only
// way an entry with something on top of it reports success is that ITS OWN pull request has been merged. Otherwise
// it WAITS, and the wait ends one of these ways:
//   - its pull request is merged (the group went through; this run no longer matters)  -> skip, success;
//   - it has become the last entry (the one on top failed or was removed)               -> run the suites in full;
//   - the cap (MAX_WAIT_SECONDS) is reached                                             -> run the suites in full;
//   - anything unknown: an API error (on the first look, or more than MAX_API_ERRORS in a row while waiting), own
//     ref gone, a cloud-built entry in the chain                                        -> run the suites in full.
// The "own pull request merged" test comes BEFORE anything that reads the queue: GitHub deletes the queue refs once
// a group has merged, so a merged entry would otherwise look like "own ref gone" and run in full for nothing.
// "Run in full" is the default and the only thing that happens on any doubt. The exit status is always 0.
//
// Timing: settle (default 120 s, at most 600 s) + the cap (80 min) + a full run (`check` takes about 45-50 min) must
// fit inside the queue's check_response_timeout (150 min; docs/ops/merge-queue-and-lanes.md). ci.yml runs the step
// only when the repository variable ROLLUP_ENABLED is 'true', and grows the job timeouts only then.
//
// Before any wait it reads the live ruleset (GET /repos/{repo}/rules/branches/{branch}, the job token is enough). It only
// waits when the merge_queue rule has grouping_strategy HEADGREEN and check_response_timeout_minutes >= 150; with ALLGREEN
// or a shorter timeout a waiting entry would be timed out and dequeued, so it runs in full at once. If the rules cannot
// be read it runs in full too.
//
// Inputs (environment, as data): CI_EVENT_NAME, MG_HEAD_REF, MG_HEAD_SHA, GITHUB_REPOSITORY, GH_TOKEN,
// SAME_TREE_ALSO_SET (as in same-tree.mjs), and optional ROLLUP_SETTLE_SECONDS (default 120, max 600).
// On skip it appends the same CI_SAME_TREE=true lines same-tree.mjs does, so every heavy step already guards on it.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { envLines } from "./same-tree.mjs";

const REF_RE = /^refs\/heads\/gh-readonly-queue\/([^/]+)\/pr-(\d+)-([0-9a-f]{40})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
export const MAX_WAIT_SECONDS = 80 * 60;
export const POLL_SECONDS = 30;
export const MAX_API_ERRORS = 2;
// Waiting is only safe when the live queue settings give the front entry room to sit out the cap and then run in full.
export const REQUIRED_GROUPING = "HEADGREEN";
export const MIN_TIMEOUT_MINUTES = 150;

/**
 * Reads the live rules of the base branch and says whether an entry may wait for the entry on top of it.
 * Returns {mayWait, reason}. mayWait is true only when a merge_queue rule says grouping_strategy HEADGREEN and
 * check_response_timeout_minutes >= 150. With ALLGREEN, or a shorter timeout, a waiting entry would be timed out and
 * dequeued (a stall); a missing rule, an unreadable answer or an error also answers false (run in full at once).
 */
export async function checkRuleset({ env, getJson }) {
  const no = (reason) => ({ mayWait: false, reason });
  try {
    const m = REF_RE.exec(env.MG_HEAD_REF ?? "");
    const repo = env.GITHUB_REPOSITORY ?? "";
    if (!m || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return no("merge group inputs missing or malformed");
    const rules = await getJson(`/repos/${repo}/rules/branches/${encodeURIComponent(m[1])}`);
    if (!Array.isArray(rules)) return no("branch rules unreadable");
    const queues = rules.filter((r) => r && r.type === "merge_queue");
    if (queues.length === 0) return no("no merge_queue rule on the branch");
    for (const r of queues) {
      const p = r.parameters;
      if (!p || typeof p !== "object") return no("merge_queue rule unreadable");
      if (p.grouping_strategy !== REQUIRED_GROUPING) return no(`grouping_strategy is ${String(p.grouping_strategy)}, not ${REQUIRED_GROUPING}`);
      const t = p.check_response_timeout_minutes;
      if (typeof t !== "number" || !Number.isFinite(t) || t < MIN_TIMEOUT_MINUTES) {
        return no(`check_response_timeout_minutes is ${String(t)}, under ${MIN_TIMEOUT_MINUTES}`);
      }
    }
    return { mayWait: true, reason: `grouping_strategy ${REQUIRED_GROUPING} and check_response_timeout_minutes >= ${MIN_TIMEOUT_MINUTES}` };
  } catch (e) {
    return no(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A cloud-built pull request (a Bot author, or an `fx/` branch), or one we cannot read: never skip around one. */
export function isCloud(pr) {
  if (!pr || typeof pr !== "object" || !pr.user || typeof pr.user !== "object" || !pr.head || typeof pr.head !== "object") return true;
  return pr.user.type === "Bot" || typeof pr.head.ref !== "string" || pr.head.ref.startsWith("fx/");
}

/**
 * One look at the queue. Returns {role: "last" | "covered" | "full", reason, covering: [{pr, sha}]}.
 * `last`    = no other queue entry sits on top of this commit: the suites must run here.
 * `full`    = unknown or unsafe: the suites run here too.
 * `covered` = at least one entry sits on top of this one.
 * Only a compare answer of exactly `ahead` with behind_by 0 counts as "on top"; `diverged`, `identical` and
 * `behind` never do.
 */
export async function classify({ env, getJson }) {
  const full = (reason) => ({ role: "full", reason, covering: [] });
  try {
    if (env.CI_EVENT_NAME !== "merge_group") return full("not a merge group run");
    const m = REF_RE.exec(env.MG_HEAD_REF ?? "");
    const mine = env.MG_HEAD_SHA ?? "";
    const repo = env.GITHUB_REPOSITORY ?? "";
    if (!m || !SHA_RE.test(mine) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return full("merge group inputs missing or malformed");
    const baseBranch = m[1];
    const myPr = Number(m[2]);
    const root = `/repos/${repo}`;
    const refs = await getJson(`${root}/git/matching-refs/heads/gh-readonly-queue/${baseBranch}/`);
    if (!Array.isArray(refs)) return full("queue refs unreadable");
    const entries = [];
    for (const r of refs) {
      const rm = r && typeof r.ref === "string" ? REF_RE.exec(r.ref) : null;
      const sha = r && r.object && typeof r.object.sha === "string" ? r.object.sha : "";
      if (!rm || !SHA_RE.test(sha)) return full("queue ref unreadable");
      entries.push({ pr: Number(rm[2]), sha });
    }
    if (!entries.some((e) => e.sha === mine)) return full("this entry is no longer in the queue (rebuilt or removed)");
    const covering = [];
    for (const e of entries) {
      if (e.sha === mine) continue;
      const cmp = await getJson(`${root}/compare/${mine}...${e.sha}`);
      if (!cmp || typeof cmp.status !== "string") return full("compare unreadable");
      if (cmp.status === "ahead" && cmp.behind_by === 0) covering.push(e);
    }
    if (covering.length === 0) return { role: "last", reason: "no queue entry sits on top of this one", covering };
    for (const n of [myPr, ...covering.map((e) => e.pr)]) {
      if (isCloud(await getJson(`${root}/pulls/${n}`))) return full(`pull request ${n} in the chain is cloud-built or unreadable`);
    }
    return { role: "covered", reason: `${covering.length} queue entr${covering.length === 1 ? "y" : "ies"} on top of this one`, covering };
  } catch (e) {
    return full(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The whole decision, with the clock and the waiting injected. Returns {skip, reason}; skip=false means run the suites.
 * `now` must be monotonic (performance.now by default): the cap must not move with the wall clock.
 */
export async function run({ env, getJson, now = () => performance.now(), sleep, settle = 0 }) {
  // Before any waiting: read the live queue settings. Anything but HEADGREEN with a long enough timeout runs in full now.
  const ruleset = await checkRuleset({ env, getJson });
  const full = (reason) => ({ skip: false, reason, ruleset });
  if (!ruleset.mayWait) return full(`ruleset: running in full at once, ${ruleset.reason}`);
  // Entries enqueued in a burst should all see each other before anyone decides it is last.
  if (settle > 0) await sleep(settle * 1000);
  const started = now();
  const refMatch = REF_RE.exec(env.MG_HEAD_REF ?? "");
  const myPr = refMatch ? Number(refMatch[2]) : NaN;
  let errors = 0;
  let sawCovered = false;
  for (;;) {
    // 1. Own pull request merged: skip. This is the only skip, and it comes before anything reads the queue.
    //    An error here is handled like any other: on the first look run in full, while waiting retry a couple of times.
    let retry = false;
    try {
      if (env.CI_EVENT_NAME === "merge_group" && Number.isInteger(myPr)) {
        const pr = await getJson(`/repos/${env.GITHUB_REPOSITORY}/pulls/${myPr}`);
        if (pr && pr.merged === true) return { skip: true, reason: `pull request ${myPr} is merged (its group went through)`, ruleset };
      }
    } catch (e) {
      if (sawCovered && errors < MAX_API_ERRORS) { errors++; retry = true; } else return full(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 2. Where is this entry in the queue?
    if (!retry) {
      const c = await classify({ env, getJson });
      if (c.role === "last") return full(c.reason);
      if (c.role === "full") {
        if (c.reason.startsWith("error:") && sawCovered && errors < MAX_API_ERRORS) errors++;
        else return full(c.reason);
      } else {
        sawCovered = true;
        errors = 0;
      }
    }
    if (now() - started >= MAX_WAIT_SECONDS * 1000) return full("waited the cap for the entries on top");
    await sleep(POLL_SECONDS * 1000);
  }
}

async function main() {
  const apiRoot = process.env.GITHUB_API_URL || "https://api.github.com";
  const getJson = async (path) => {
    const r = await fetch(apiRoot + path, {
      headers: { authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, accept: "application/vnd.github+json", "user-agent": "ci-rollup" },
    });
    if (!r.ok) throw new Error(`GET ${path.split("?")[0].split("/").slice(-1)[0]} answered ${r.status}`);
    return r.json();
  };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const settleRaw = Number(process.env.ROLLUP_SETTLE_SECONDS || "120");
  const settle = Number.isFinite(settleRaw) && settleRaw >= 0 && settleRaw <= 600 ? settleRaw : 120;
  const { skip, reason, ruleset } = process.env.CI_EVENT_NAME === "merge_group"
    ? await run({ env: process.env, getJson, sleep, settle })
    : { skip: false, reason: "not a merge group run" };
  const line = skip
    ? `CI scope: rollup, ${reason}; the suites are skipped in this merge queue run`
    : `CI scope: rollup, running in full (${reason})`;
  console.log(`rollup_skip=${skip}`);
  console.log(line);
  // One warning says which ruleset case applied. A silent no-op must be visible: say so too when the queue could not be read.
  if (ruleset) {
    console.log(ruleset.mayWait
      ? `::warning::rollup: the live queue rules allow waiting (${ruleset.reason})`
      : `::warning::rollup: not waiting, the suites run in full at once (${ruleset.reason})`);
  } else if (!skip && /error:|unreadable|malformed/.test(reason)) console.log(`::warning::rollup: could not read the merge queue, so nothing is covered (${reason})`);
  try {
    if (skip && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, envLines(process.env.SAME_TREE_ALSO_SET));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
  } catch {
    // A failed write leaves the answer at "run in full".
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log("rollup_skip=false");
    console.log(`CI scope: rollup, running in full (error: ${e instanceof Error ? e.message : String(e)})`);
    console.log(`::warning::rollup: failed before deciding, so nothing is covered (${e instanceof Error ? e.message : String(e)})`);
  });
}
