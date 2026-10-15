import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoPairing } from "@fx/core/src/repos/pairing.js";

/** The pairing as the route needs it: defined once, with the data that owns it, in packages/core/src/repos/pairing.ts. */
export type { RepoPairing };
import { compileOverlay, parseIdentifierRules, parsePlanData, scanPlanePush, scanText, type IdentifierRuleSet, type PlanData, type Refusal } from "./planePush.js";
import { git, gitCommitSource } from "./planePushGit.js";
import { PUBLIC_BASE_BRANCH, branchNameOk, type PublicGitTransport } from "./planePushTransport.js";

/**
 * Executor push routing for a repo that is paired with a public code repo (D#598 item 1).
 *
 * With no pairing the answer is `single`: the repo and base the item uses today, and nothing here runs. With a pairing, the item's
 * change goes out as ONE commit whose only parent is the public repo's main tip, never as private history:
 *
 *   1. read the public tip; take the item's changed paths between its private base and head;
 *   2. refuse a path the public tip has moved on since the item's base (applying our blob would silently revert someone else's edit);
 *   3. build the commit from git plumbing in a temporary index (public tip's tree plus those paths), with a fixed platform identity;
 *   4. scan it on its git objects (`scanPlanePush`), and scan the WHOLE raw commit object, the PR title and the PR body with the same
 *      rules (`scanText`): the scan reads changed files, not the commit's own message, author or committer lines;
 *   5. mint a token for the paired repo alone, with contents and pull_requests write alone;
 *   6. at push time, check again: the pairing is unchanged and does not point at this repo, the public tip is still the one the commit
 *      was built and scanned on, the scan reported exactly this commit and this base, and the branch does not exist yet;
 *   7. push (never forced) and open the PR.
 *
 * Every doubt is a refusal and no refusal pushes anything. A refusal names a place (path, line) and a rule key, never matched text.
 * Not done here: a second push to a branch that already exists (a fix round on a paired PR) is refused as `branch_exists`.
 */

export type PlaneRefusalCode =
  | "bad_input"
  | "pairing_self"
  | "pairing_changed"
  | "base_diverged"
  | "no_changes"
  | "scan_refused"
  | "scan_identity_mismatch"
  | "public_unavailable"
  | "public_tip_moved"
  | "app_not_installed"
  | "token_scope_mismatch"
  | "branch_exists"
  | "push_failed"
  | "unsafe_git_config"
  | "pr_failed";

export const PLANE_REFUSAL_CODES: readonly PlaneRefusalCode[] = [
  "bad_input", "pairing_self", "pairing_changed", "base_diverged", "no_changes", "scan_refused", "scan_identity_mismatch", "public_unavailable",
  "public_tip_moved", "app_not_installed", "token_scope_mismatch", "branch_exists", "push_failed", "pr_failed", "unsafe_git_config",
];

export class PlaneRouteError extends Error {
  constructor(
    readonly code: PlaneRefusalCode,
    message: string,
    /** For `scan_refused`: what the scan found, by place and rule key. */
    readonly refusals: readonly Refusal[] = [],
    /** True once a branch was sent to the public repo (`pr_failed` only): the branch exists and only the PR is missing. */
    readonly pushed = false,
  ) {
    super(message);
    this.name = "PlaneRouteError";
  }
}

/** The calls to the public repo's GitHub API. Production: `createPlanePushApi` in `@fx/github`. Failures carry a string `code`. */
export interface PublicApi {
  /** A token for the paired repo alone with contents and pull_requests write alone; throws `{code: "app_not_installed" | "token_scope_mismatch"}`. */
  mintPushToken(codeRepo: string): Promise<string>;
  branchExists(input: { codeRepo: string; branch: string; token: string }): Promise<boolean>;
  openPullRequest(input: { codeRepo: string; branch: string; base: string; title: string; body: string; token: string }): Promise<{ number: number; url: string }>;
}

export interface OwnRepo {
  owner: string;
  name: string;
}

export type RouteDecision =
  | { plane: "single"; repo: string; base: string }
  | { plane: "paired"; repo: string; base: typeof PUBLIC_BASE_BRANCH; pairing: RepoPairing & { enabled: true; codeRepo: string } };

const fullName = (own: OwnRepo): string => `${own.owner}/${own.name}`;
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The plane for an item. No pairing (or one that is off) is the single-repo path, unchanged. A pairing that names this repo is refused. */
export function routeFor(pairing: RepoPairing, own: OwnRepo, defaultBranch: string): RouteDecision {
  if (!pairing.enabled || pairing.codeRepo === null) return { plane: "single", repo: fullName(own), base: defaultBranch };
  if (sameRepo(pairing.codeRepo, fullName(own))) throw new PlaneRouteError("pairing_self", "the paired public repo is this repo; nothing is pushed");
  return { plane: "paired", repo: pairing.codeRepo, base: PUBLIC_BASE_BRANCH, pairing: pairing as RepoPairing & { enabled: true; codeRepo: string } };
}

export interface PlaneRouteInput {
  /** A private clone that holds both the item's commits and (after the fetch) the public repo's objects. */
  repoDir: string;
  /** The private commit the item started from, and its work: full 40-hex ids. */
  privateBase: string;
  privateHead: string;
  own: OwnRepo;
  defaultBranch: string;
  /** The public branch to create. */
  branch: string;
  /** Plain text, one line. Scanned with the commit. */
  title: string;
  body: string;
  /** The platform's own identity on the public commit; the item's private author and committer are never copied. */
  identity: { name: string; email: string };
  /** Seconds since the epoch for author and committer dates. */
  commitTime: number;
}

export interface PlaneRouteDeps {
  loadPairing(): Promise<RepoPairing>;
  loadOwn(): Promise<OwnRepo>;
  api: PublicApi;
  transport: PublicGitTransport;
}

export type PlaneRouteResult =
  | { plane: "single"; repo: string; base: string }
  | { plane: "paired"; repo: string; number: number; url: string; branch: string; commit: string; tip: string };

const OBJECT_ID = /^[0-9a-f]{40}$/;
const ZERO_ID = "0".repeat(40);
const GIT_SAFE_LINE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const IDENTITY = /^[A-Za-z0-9 ._-]{1,100}$/;
const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,100}$/;
const MAX_BODY = 60_000;
const LS_BATCH = 100;

interface Change {
  /** The path as git reports it, one byte per char. */
  key: string;
  deleted: boolean;
  mode: string;
  sha: string;
}

interface TreeEntry {
  mode: string;
  sha: string;
}

const decoder = new TextDecoder("utf-8");

function validateInput(i: PlaneRouteInput): void {
  const bad = (why: string): never => {
    throw new PlaneRouteError("bad_input", why);
  };
  if (!OBJECT_ID.test(i.privateBase) || !OBJECT_ID.test(i.privateHead)) bad("the private base and head must be full 40-hex commit ids");
  if (!branchNameOk(i.branch)) bad("the branch name is not usable on the public repo");
  if (!GIT_SAFE_LINE.test(i.title) || i.title.trim() !== i.title) bad("the title must be one plain line of at most 256 characters");
  if (i.body.length === 0 || i.body.length > MAX_BODY || /\u0000/.test(i.body)) bad("the body must be non-empty text of at most 60000 characters");
  if (!IDENTITY.test(i.identity.name) || !EMAIL.test(i.identity.email)) bad("the platform identity is malformed");
  if (!Number.isSafeInteger(i.commitTime) || i.commitTime < 0) bad("the commit time must be whole seconds");
}

/** The paths the item changes between its private base and head, with the new mode and blob (or a delete). */
async function itemChanges(repoDir: string, base: string, head: string): Promise<Change[]> {
  const raw = (await git(repoDir, ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", base, head, "--"])).toString("latin1").split("\0");
  const out: Change[] = [];
  for (let n = 0; n + 1 < raw.length; n += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) (\w)$/.exec(raw[n] ?? "");
    if (!m) throw new Error("git diff --raw output is not understood");
    out.push({ key: raw[n + 1] as string, deleted: m[5] === "D", mode: m[2] as string, sha: m[4] as string });
  }
  return out;
}

/** Mode and blob at `rev` for each of `keys` (absent paths are missing from the map). Matches paths literally. */
async function treeEntries(repoDir: string, rev: string, keys: readonly string[]): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  for (let n = 0; n < keys.length; n += LS_BATCH) {
    const batch = keys.slice(n, n + LS_BATCH);
    // Keys are latin1 (one char per byte, so distinct byte strings stay distinct); argv wants the UTF-8 text. A name that is not valid
    // UTF-8 finds nothing here and is refused by the scan as a malformed path.
    const buf = await git(repoDir, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", rev, "--", ...batch.map((k) => Buffer.from(k, "latin1").toString("utf8"))]);
    for (const rec of buf.toString("latin1").split("\0")) {
      const m = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/.exec(rec);
      if (m) out.set(m[4] as string, { mode: m[1] as string, sha: m[3] as string });
    }
  }
  return out;
}

/**
 * Refuses when the public tip has moved on a path the item changes since the item's private base: building from our blob would
 * revert the public edit. A path the tip already has exactly as the item wants it is fine. Overlay paths are skipped here, because
 * the scan refuses them by name, which is the more useful message.
 */
async function assertNoBaseGap(repoDir: string, changes: readonly Change[], privateBase: string, privateHead: string, tip: string, overlayMatch: (p: string) => boolean): Promise<void> {
  const keys = changes.filter((c) => !overlayMatch(Buffer.from(c.key, "latin1").toString("utf8"))).map((c) => c.key);
  if (keys.length === 0) return;
  const ordinal = new Map(changes.map((c, n) => [c.key, n + 1]));
  const [atBase, atTip, atHead] = await Promise.all([treeEntries(repoDir, privateBase, keys), treeEntries(repoDir, tip, keys), treeEntries(repoDir, privateHead, keys)]);
  const same = (a?: TreeEntry, b?: TreeEntry): boolean => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.mode === b.mode && a.sha === b.sha);
  const diverged: string[] = [];
  for (const k of keys) if (!same(atTip.get(k), atBase.get(k)) && !same(atTip.get(k), atHead.get(k))) diverged.push(`changed path #${ordinal.get(k)}`);
  if (diverged.length > 0) throw new PlaneRouteError("base_diverged", `the public repo changed ${diverged.slice(0, 5).join(", ")} since this item started; refresh the item and run it again`);
}

/** One commit on `tip` with the item's paths applied, built in a throwaway index. No ref, working tree or real index is touched. */
async function buildCommit(i: PlaneRouteInput, changes: readonly Change[], tip: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plane-route-"));
  try {
    const env = {
      GIT_INDEX_FILE: join(dir, "index"),
      GIT_AUTHOR_NAME: i.identity.name,
      GIT_AUTHOR_EMAIL: i.identity.email,
      GIT_AUTHOR_DATE: `${i.commitTime} +0000`,
      GIT_COMMITTER_NAME: i.identity.name,
      GIT_COMMITTER_EMAIL: i.identity.email,
      GIT_COMMITTER_DATE: `${i.commitTime} +0000`,
    };
    await git(i.repoDir, ["read-tree", tip], undefined, env);
    const info = Buffer.concat(
      changes.map((c) => Buffer.concat([Buffer.from(c.deleted ? `0 ${ZERO_ID}\t` : `${c.mode} ${c.sha}\t`, "latin1"), Buffer.from(c.key, "latin1"), Buffer.from([0])])),
    );
    await git(i.repoDir, ["update-index", "-z", "--index-info"], info, env);
    const tree = (await git(i.repoDir, ["write-tree"], undefined, env)).toString("utf8").trim();
    const tipTree = (await git(i.repoDir, ["rev-parse", "--verify", `${tip}^{tree}`])).toString("utf8").trim();
    if (tree === tipTree) throw new PlaneRouteError("no_changes", "the item changes nothing the public repo does not already have");
    return (await git(i.repoDir, ["commit-tree", tree, "-p", tip, "-F", "-"], `${i.title}\n`, env)).toString("utf8").trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readRuleFile(repoDir: string, head: string, path: string): Promise<Uint8Array | null> {
  try {
    return await git(repoDir, ["cat-file", "blob", `${head}:${path}`]);
  } catch {
    return null; // missing, or unreadable: either way a declared rule file that is not there refuses the push
  }
}

function failure(err: unknown, fallback: PlaneRefusalCode, message: string): PlaneRouteError {
  if (err instanceof PlaneRouteError) return err;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return new PlaneRouteError(typeof code === "string" && (PLANE_REFUSAL_CODES as readonly string[]).includes(code) ? (code as PlaneRefusalCode) : fallback, message);
}

/** The pairing as it must still be at push time: on, and the same repo, overlay list and rule files that were scanned. */
function samePairing(a: RepoPairing, b: RepoPairing): boolean {
  return (
    a.enabled && b.enabled && a.codeRepo !== null && b.codeRepo !== null && sameRepo(a.codeRepo, b.codeRepo) &&
    a.identifierRulesPath === b.identifierRulesPath && a.planDataRulesPath === b.planDataRulesPath &&
    a.overlayGlobs.length === b.overlayGlobs.length && a.overlayGlobs.every((g, n) => g === b.overlayGlobs[n])
  );
}

export async function routeAndPush(input: PlaneRouteInput, deps: PlaneRouteDeps): Promise<PlaneRouteResult> {
  const pairing = await deps.loadPairing();
  const own = await deps.loadOwn();
  const decision = routeFor(pairing, own, input.defaultBranch);
  if (decision.plane === "single") return decision;
  validateInput(input);
  const codeRepo = decision.repo;
  const { overlayGlobs } = decision.pairing;

  let tip: string;
  try {
    tip = await deps.transport.fetchTip(input.repoDir, codeRepo);
  } catch (err) {
    throw failure(err, "public_unavailable", "the public repo's main could not be read");
  }
  const overlay = compileOverlay(overlayGlobs);
  if ("error" in overlay) throw new PlaneRouteError("scan_refused", overlay.error, [{ kind: "overlay_list_invalid", message: overlay.error }]);

  const changes = await itemChanges(input.repoDir, input.privateBase, input.privateHead);
  if (changes.length === 0) throw new PlaneRouteError("no_changes", "the item changes no files");
  await assertNoBaseGap(input.repoDir, changes, input.privateBase, input.privateHead, tip, overlay.match);
  const commit = await buildCommit(input, changes, tip);

  // The scan: changed files by git object, then every other line of text that will be published, with the same rules.
  const ruleFiles = {
    ...(decision.pairing.identifierRulesPath ? { identifierRules: decision.pairing.identifierRulesPath } : {}),
    ...(decision.pairing.planDataRulesPath ? { planData: decision.pairing.planDataRulesPath } : {}),
  };
  const scan = await scanPlanePush({
    overlay: overlayGlobs,
    ruleFiles,
    readRuleFile: (p) => readRuleFile(input.repoDir, input.privateHead, p),
    source: gitCommitSource({ repoDir: input.repoDir, commit, base: tip }),
  });
  const refusals: Refusal[] = [...scan.refusals];
  if (scan.ok) {
    let identifierRules: IdentifierRuleSet | undefined;
    let planData: PlanData | undefined;
    const idBytes = ruleFiles.identifierRules ? await readRuleFile(input.repoDir, input.privateHead, ruleFiles.identifierRules) : null;
    const pdBytes = ruleFiles.planData ? await readRuleFile(input.repoDir, input.privateHead, ruleFiles.planData) : null;
    const idParsed = idBytes ? parseIdentifierRules(decoder.decode(idBytes)) : undefined;
    const pdParsed = pdBytes ? parsePlanData(decoder.decode(pdBytes)) : undefined;
    if (idParsed && !("error" in idParsed)) identifierRules = idParsed;
    if (pdParsed && !("error" in pdParsed)) planData = pdParsed;
    if ((ruleFiles.identifierRules && !identifierRules) || (ruleFiles.planData && !planData)) {
      refusals.push({ kind: "rule_file_invalid", message: "a declared rule file could not be read again for the text scan" });
    } else {
      // The raw commit object: tree and parent lines, author and committer identities, any extra header, and the message.
      const object = decoder.decode(await git(input.repoDir, ["cat-file", "commit", commit]));
      refusals.push(
        ...scanText("commit object", object, { identifierRules, planData }),
        ...scanText("branch name", input.branch, { identifierRules, planData }),
        ...scanText("pull request title", input.title, { identifierRules, planData }),
        ...scanText("pull request body", input.body, { identifierRules, planData }),
      );
    }
  }
  if (refusals.length > 0) {
    throw new PlaneRouteError("scan_refused", `the change was not sent: ${refusals.slice(0, 5).map((r) => r.message).join("; ")}${refusals.length > 5 ? ` (and ${refusals.length - 5} more)` : ""}`, refusals.slice(0, 100));
  }

  let token: string;
  try {
    token = await deps.api.mintPushToken(codeRepo);
  } catch (err) {
    throw failure(err, "public_unavailable", "a token for the public repo could not be minted");
  }

  // ---- push time: nothing above is trusted any more -------------------------------------------------------------------------
  const nowPairing = await deps.loadPairing();
  const nowOwn = await deps.loadOwn();
  if (nowPairing.enabled && nowPairing.codeRepo !== null && sameRepo(nowPairing.codeRepo, fullName(nowOwn))) {
    throw new PlaneRouteError("pairing_self", "the paired public repo is this repo; nothing is pushed");
  }
  if (!samePairing(pairing, nowPairing)) throw new PlaneRouteError("pairing_changed", "the pairing changed while the item was being prepared; nothing is pushed");
  let freshTip: string;
  try {
    freshTip = await deps.transport.fetchTip(input.repoDir, codeRepo);
  } catch (err) {
    throw failure(err, "public_unavailable", "the public repo's main could not be read again before the push");
  }
  if (freshTip !== tip) throw new PlaneRouteError("public_tip_moved", "the public repo's main moved while the item was being prepared; run it again");
  if (!scan.scanned || scan.scanned.commit !== commit || scan.scanned.base !== freshTip) {
    throw new PlaneRouteError("scan_identity_mismatch", "the scan did not cover exactly this commit on the public repo's current main; nothing is pushed");
  }
  try {
    if (await deps.api.branchExists({ codeRepo, branch: input.branch, token })) throw new PlaneRouteError("branch_exists", "that branch already exists on the public repo; nothing is pushed");
    await deps.transport.push({ repoDir: input.repoDir, codeRepo, commit, branch: input.branch, token });
  } catch (err) {
    throw failure(err, "push_failed", "the push to the public repo failed");
  }
  try {
    const pr = await deps.api.openPullRequest({ codeRepo, branch: input.branch, base: PUBLIC_BASE_BRANCH, title: input.title, body: input.body, token });
    return { plane: "paired", repo: codeRepo, number: pr.number, url: pr.url, branch: input.branch, commit, tip: freshTip };
  } catch (err) {
    const e = failure(err, "pr_failed", "the branch was pushed but the pull request could not be opened");
    throw new PlaneRouteError("pr_failed", e.message, [], true);
  }
}
