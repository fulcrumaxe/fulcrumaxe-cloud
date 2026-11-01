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
