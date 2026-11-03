import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourcePaths } from "../../../test-guard/src/sourceFiles.js";

/**
 * D#598 P1d-1 (R-P1d-1): every way the product merges passes `runMergeGate`, which is where the author rule lives. This reads the production sources and fails when a
 * file outside the short lists below can call the merge, the queue enqueue, the auto-merge document or the merge endpoint, or mint the `plane_merge` credential.
 * A new caller has to be added here on purpose, in a change a reviewer reads.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".git", "test", "tests", "e2e", "__tests__"]);
const production = (): string[] =>
  listSourcePaths(REPO_ROOT, ["packages", "apps"], SKIP_DIRS)
    .filter((f) => /\.(?:ts|tsx|mts|js|mjs)$/.test(f) && !/\.(?:test|spec)\./.test(path.basename(f)) && !f.endsWith(".d.ts"))
    .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"));
const mentioning = (re: RegExp): string[] => production().filter((f) => re.test(readFileSync(path.join(REPO_ROOT, f), "utf8"))).sort();

const MERGE_CALLS = ["packages/fx-runner/src/daemon/planePushGithub.ts", "packages/github/src/mergeGateGraphql.ts", "packages/pipeline/src/build/githubMergePort.ts", "packages/pipeline/src/build/mergeGate.ts", "packages/pipeline/src/review/mergeGateRun.ts", "packages/runner-protocol/src/planePush/mergeQueueGraphql.ts"];
const DOCUMENTS = ["apps/web/lib/advanceReview.ts", "apps/web/lib/mergeQueue.ts", "apps/web/lib/mergeQueueMode.ts", "apps/web/lib/planeMerge.ts", "packages/fx-runner/src/daemon/planePushGithub.ts", "packages/github/src/mergeGateGraphql.ts", "packages/runner-protocol/src/planePush/mergeQueueGraphql.ts"];
const MINTS = ["apps/web/lib/github/planePushHosted.ts", "packages/github/src/planePushApi.ts", "packages/github/src/planePushHosted.ts", "packages/runner-cloud/src/http.ts", "packages/runner-cloud/src/planeMerge.ts"];

describe("R-P1d-1: the merge gate is the only way the product merges", () => {
  it("scans the production sources, the gate's own files among them", () => {
    expect(production().length).toBeGreaterThan(500);
    expect(production()).toContain("packages/pipeline/src/build/mergeGate.ts");
  });

  it("only the gate, its port and the runner name the merge, enqueue or auto-merge calls", () => {
    expect(mentioning(/\b(?:mergePullRequest|enqueuePullRequest)\b/)).toEqual(MERGE_CALLS);
  });

  it("only the gate's file (its definition) and the one write-back caller name mergeRecordedHead anywhere (call, alias, re-export or passed as a value), which carries no checks of its own", () => {
    expect(mentioning(/\bmergeRecordedHead\b/)).toEqual(["apps/web/lib/mergeQueue.ts", "packages/pipeline/src/build/mergeGate.ts"]);
  });

  it("in the write-back gate the merge call sits after the merge decision and its refusal", () => {
    const src = readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/mergeQueue/writeback.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function runWritebackGate("));
    const decided = fn.indexOf("decideWritebackMerge({ ...base, evidence })");
    const refuse = fn.indexOf('if (decided.decision !== "merge")');
    const merge = fn.indexOf("deps.writeback.merge(");
    expect(decided).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(decided);
    expect(merge).toBeGreaterThan(refuse);
    expect(fn.indexOf("deps.writeback.merge(", merge + 1)).toBe(-1);
  });

  it("only the documents' home, the runner and four composition roots name the enqueue and auto-merge documents", () => {
    expect(mentioning(/\b(?:ENQUEUE_PULL_REQUEST_DOCUMENT|ENABLE_AUTO_MERGE_DOCUMENT)\b/)).toEqual(DOCUMENTS);
  });

  it("only the port and the runner build the merge endpoint's path", () => {
    expect(mentioning(/\/pulls\/\$\{[^}]+\}\/merge/)).toEqual(["packages/fx-runner/src/daemon/planePushGithub.ts", "packages/pipeline/src/build/githubMergePort.ts"]);
  });

  it("only the runner API's go phase and the token builders mint the plane_merge credential", () => {
    expect(mentioning(/\bmintMergeToken\b/)).toEqual(MINTS);
    expect(mentioning(/\.mintMergeToken\([^)]*"write"\)/)).toEqual(["packages/runner-cloud/src/planeMerge.ts"]);
  });

  it("the gate's one caller is the item run, which hands the gate the author port", () => {
    expect(mentioning(/\brunMergeGate\(/)).toEqual(["packages/pipeline/src/build/mergeGate.ts", "packages/pipeline/src/review/mergeGateRun.ts"]);
    expect(readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/review/mergeGateRun.ts"), "utf8")).toMatch(/pullRequestAuthorTrust:\s*createPullRequestAuthorTrust\(/);
  });

  it("D#483 S5-j2a1: the merge lease is taken before the gate reads anything, freed in the one finally, and only the gate, its caller and the lease module name acquireMergeLease", () => {
    expect(mentioning(/\bacquireMergeLease\b/)).toEqual(["packages/pipeline/src/build/mergeGate.ts", "packages/pipeline/src/mergeQueue/mergeLease.ts", "packages/pipeline/src/review/mergeGateRun.ts"]);
    const src = readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/build/mergeGate.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function runMergeGate("));
    const lease = fn.indexOf("deps.acquireMergeLease()");
    const inner = fn.indexOf("runMergeGateLeased(deps, input, lease");
    const release = fn.indexOf("lease.release()");
    const firstRead = fn.indexOf("deps.github.getPullRequest(");
    expect(lease).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(lease);
    expect(release).toBeGreaterThan(inner);
    // Nothing is read for the decision, and nothing merges, before the lease: every read and both merge call sites sit in the leased function, after the finally that frees it.
    expect(firstRead).toBeGreaterThan(release);
    expect(fn.indexOf("deps.github.mergePullRequest(")).toBeGreaterThan(release);
    expect(fn.indexOf("enqueueIntoQueue(deps")).toBeGreaterThan(release);
    expect(fn.match(/lease\.release\(\)/g)).toHaveLength(1);
    // The caller wires the lease for every caller but the queue tick, which holds the slot.
    expect(readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/review/mergeGateRun.ts"), "utf8")).toMatch(/input\.underQueueSlot === true\s*\?\s*\{\}\s*:\s*\{\s*acquireMergeLease:/);
    expect(mentioning(/\bunderQueueSlot: true\b/)).toEqual(["apps/web/lib/mergeQueue.ts"]);
  });

  it("D#483 S5-j2a2: the order check runs under the lease, its reasons are gathered before the stop, the merge call sits after both, and the caller wires it for every merge", () => {
    const src = readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/build/mergeGate.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function runMergeGate("));
    const leased = fn.indexOf("async function runMergeGateLeased(");
    const confirm = fn.indexOf("await lease.confirm()");
    const call = fn.indexOf("await mergeOrderReasons(deps, input, headSha)");
    const stop = fn.indexOf("if (reasons.length > 0) {");
    expect(leased).toBeGreaterThan(0);
    expect(fn.indexOf("deps.acquireMergeLease()")).toBeLessThan(leased);
    expect(call).toBeGreaterThan(leased);
    expect(stop).toBeGreaterThan(call);
    expect(fn.indexOf("deps.github.mergePullRequest(")).toBeGreaterThan(stop);
    expect(fn.indexOf("enqueueIntoQueue(deps")).toBeGreaterThan(stop);
    // R-C35-5: the lease is renewed and re-confirmed after the stop and before both the enqueue and the merge call.
    expect(confirm).toBeGreaterThan(stop);
    expect(fn.indexOf("deps.github.mergePullRequest(")).toBeGreaterThan(confirm);
    expect(fn.indexOf("enqueueIntoQueue(deps")).toBeGreaterThan(confirm);
    expect(fn.match(/lease\.confirm\(\)/g)).toHaveLength(1);
    expect(fn.match(/await mergeOrderReasons\(/g)).toHaveLength(1);
    // The check is the port the caller hands in, never a call to the queue's `orderedStep` (which stops entries and renews slots).
    expect(src).not.toMatch(/orderedStep/);
    const run = readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/review/mergeGateRun.ts"), "utf8");
    expect(run).toMatch(/\.\.\.createMergeOrder\(\{ pool, github: mergePort, runnerLocal \}\)/);
    expect(mentioning(/\bcreateMergeOrder\b/)).toEqual(["packages/pipeline/src/mergeQueue/mergeOrderCheck.ts", "packages/pipeline/src/review/mergeGateRun.ts"]);
    expect(mentioning(/\borderedStep\(/)).toEqual(["packages/pipeline/src/mergeQueue/orderedCheck.ts", "packages/pipeline/src/mergeQueue/tick.ts"]);
    // R-C34-F4: a pull request put in GitHub's merge queue keeps the lease (the one release stays in the finally), and the settle path frees it from the webhook.
    expect(fn.indexOf("lease?.holdForHostQueue")).toBeGreaterThan(fn.indexOf("runMergeGateLeased(deps, input, lease"));
    expect(mentioning(/\breleaseHostQueueLease\b/)).toEqual(["packages/pipeline/src/mergeQueue/events.ts", "packages/pipeline/src/mergeQueue/mergeLease.ts"]);
  });

  it("inside the gate, the author reasons are gathered before the stop, and both merge call sites sit after it", () => {
    const src = readFileSync(path.join(REPO_ROOT, "packages/pipeline/src/build/mergeGate.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function runMergeGate("));
    const author = fn.indexOf("authorReasons(deps");
    const stop = fn.indexOf("if (reasons.length > 0) {");
    expect(author).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(author);
    expect(fn.indexOf("deps.github.mergePullRequest(")).toBeGreaterThan(stop);
    expect(fn.indexOf("enqueueIntoQueue(deps")).toBeGreaterThan(stop);
    expect(fn.indexOf("input.mergeUnavailableReason")).toBeGreaterThan(stop);
  });
});
