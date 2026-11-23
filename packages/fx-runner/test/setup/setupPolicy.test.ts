import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTipTree } from "../../src/daemon/vmBundle.js";
import { PROJECT_SETUP_HOSTS, PROJECT_SETUP_NETWORK, bundleReasonOf, isWorkflowPath, projectSetupPolicy, workflowPolicy } from "../../src/setup/setupPolicy.js";
import { parseEgressPolicy } from "../../src/vm/egress/policy.js";
import { BundleRefused } from "../../src/vm/workspace/bundleHeader.js";
import { BundlePullError } from "../../src/vm/workspace/bundleOut.js";
import { ArchiveRefused } from "../../src/vm/workspace/tar.js";
import { GIT_ENV, git, hostDeps, scratchDir } from "../vm/workspace/helpers.js";

/** D#845 ON-8d: the two closed policies. */
describe("the project_setup egress template", () => {
  it("is the npm registry and the two Python package hosts, direct, and nothing else; the proxy's own parser reads it", () => {
    const policy = parseEgressPolicy(projectSetupPolicy());
    expect([...policy.hosts]).toEqual([["registry.npmjs.org", "direct"], ["pypi.org", "direct"], ["files.pythonhosted.org", "direct"]]);
    expect(policy.routes.size).toBe(0);
    expect(PROJECT_SETUP_HOSTS).toEqual(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
  });

  it("carries no github host, no model host, no address, no wildcard and no header to inject", () => {
    const text = JSON.stringify(projectSetupPolicy());
    for (const forbidden of ["github", "anthropic", "*", "127.", "localhost"]) expect(text.includes(forbidden), forbidden).toBe(false);
    for (const rule of PROJECT_SETUP_NETWORK) expect(rule).not.toHaveProperty("authHeader");
  });
});

describe("the closed reason of a bundle refusal", () => {
  it.each([
    [new BundleRefused("bundle_too_large"), "size"],
    [new BundleRefused("bundle_tree", "symlink"), "symlink"],
    [new BundleRefused("bundle_tree", "path"), "path"],
    [new BundleRefused("bundle_tree"), "path"],
    [new BundleRefused("bundle_tree", "workflow"), "workflow"],
    [new BundleRefused("bundle_malformed"), "path"],
    [new BundleRefused("bundle_prerequisite"), "path"],
    [new BundleRefused("bundle_ref"), "path"],
    [new BundleRefused("bundle_commits"), "path"],
    [new BundleRefused("bundle_base_moved"), "path"],
    [new BundleRefused("bundle_fetch_failed"), "path"],
    [new ArchiveRefused("archive_too_large"), "size"],
    [new ArchiveRefused("archive_link"), "symlink"],
    [new ArchiveRefused("archive_path"), "path"],
    [new ArchiveRefused("archive_type"), "path"],
    [new ArchiveRefused("archive_malformed"), "path"],
    [new BundlePullError("bundle_too_large"), "size"],
    [new BundlePullError("bundle_size_mismatch"), "size"],
  ])("%s is %s", (error, reason) => expect(bundleReasonOf(error)).toBe(reason));

  it("a pull that failed, or anything that is not a bundle refusal, has no reason (it is a workspace failure, not a refused bundle)", () => {
    expect(bundleReasonOf(new BundlePullError("bundle_pull_failed"))).toBeUndefined();
    expect(bundleReasonOf(new Error("x"))).toBeUndefined();
    expect(bundleReasonOf("size")).toBeUndefined();
  });
});

describe("what is a workflow path", () => {
  it.each([[".github", true], [".github/workflows", true], [".github/workflows/ci.yml", true], [".GitHub/Workflows/ci.yml", true], [".GITHUB/WORKFLOWS", true], [".github/workflows/sub/deep.yml", true], [".github/CODEOWNERS", false], [".github/workflows-old/x", false], ["github/workflows/ci.yml", false], ["src/.github/workflows/ci.yml", false], [".githubx/workflows/a", false], ["docs/workflows.md", false]])("%s", (name, expected) => expect(isWorkflowPath(name as string)).toBe(expected));
});

describe("the workflow rule on real commits", () => {
  /** A repo with a base commit holding some files, and a tip commit made by `change`. */
  function repoWith(base: Record<string, string>, change: (dir: string) => void): { repo: string; baseId: string; tipId: string } {
    const root = scratchDir("fx-wf-");
    const repo = path.join(root, "r");
    git(root, "init", "-q", "r");
    for (const [name, text] of Object.entries(base)) {
      mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
      writeFileSync(path.join(repo, name), text);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    const baseId = git(repo, "rev-parse", "HEAD");
    change(repo);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--allow-empty", "-m", "tip");
    return { repo, baseId, tipId: git(repo, "rev-parse", "HEAD") };
  }
  const verdict = async (r: ReturnType<typeof repoWith>): Promise<string> => {
    try {
      await workflowPolicy(hostDeps().gitLarge)({ repo: r.repo, base: r.baseId, tip: r.tipId });
      return "ok";
    } catch (error) {
      return `${(error as BundleRefused).code}/${(error as BundleRefused).detail}`;
    }
  };
  const write = (dir: string, name: string, text: string): void => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };

  it("an added, a changed, a deleted and a renamed-away workflow file are each refused, and an added file in another case too", async () => {
    const withCi = { ".github/workflows/ci.yml": "a\n", "README.md": "x\n" };
    expect(await verdict(repoWith({}, (d) => write(d, ".github/workflows/new.yml", "n\n")))).toBe("bundle_tree/workflow");
    expect(await verdict(repoWith(withCi, (d) => write(d, ".github/workflows/ci.yml", "b\n")))).toBe("bundle_tree/workflow");
    expect(await verdict(repoWith(withCi, (d) => execFileSync("rm", [path.join(d, ".github/workflows/ci.yml")])))).toBe("bundle_tree/workflow");
    expect(await verdict(repoWith(withCi, (d) => void execFileSync("git", ["mv", ".github/workflows/ci.yml", "ci.yml"], { cwd: d, env: GIT_ENV() })))).toBe("bundle_tree/workflow");
    expect(await verdict(repoWith({}, (d) => write(d, ".GitHub/Workflows/x.yml", "n\n")))).toBe("bundle_tree/workflow");
  });

  it("a plain file turned into a .github link is refused; other .github files, other files and a change that touches no workflow are not", async () => {
    expect(await verdict(repoWith({ ".github": "file\n" }, (d) => { execFileSync("rm", [path.join(d, ".github")]); symlinkSync("elsewhere", path.join(d, ".github")); }))).toBe("bundle_tree/workflow");
    expect(await verdict(repoWith({}, (d) => write(d, ".github/CODEOWNERS", "* @a\n")))).toBe("ok");
    expect(await verdict(repoWith({ ".github/workflows/ci.yml": "a\n" }, (d) => write(d, "src/a.ts", "export {}\n")))).toBe("ok");
    expect(await verdict(repoWith({}, (d) => write(d, "docs/workflows/a.md", "x\n")))).toBe("ok");
  });

  it("anything but exactly one commit on the base is refused bundle_commits/path: a file added by one commit and removed by the next would still be in the pushed history, and the earlier tree is never checked", async () => {
    const r = repoWith({}, (d) => write(d, ".github/workflows/tmp.yml", "on: push\n"));
    execFileSync("rm", [path.join(r.repo, ".github/workflows/tmp.yml")]);
    git(r.repo, "add", "-A");
    git(r.repo, "commit", "-q", "-m", "second");
    const tip = git(r.repo, "rev-parse", "HEAD");
    expect(git(r.repo, "diff", "--name-only", r.baseId, tip)).toBe("");
    expect(await verdict({ ...r, tipId: tip })).toBe("bundle_commits/path");
    // no commit at all, and a tip that is not a child of the base, are refused too
    expect(await verdict({ ...r, tipId: r.baseId })).toBe("bundle_commits/path");
    expect(await verdict({ ...r, baseId: tip, tipId: r.tipId })).toBe("bundle_commits/path");
  });

  it("a link out of the tree is the tree check's own refusal and maps to symlink", async () => {
    const r = repoWith({}, (d) => symlinkSync("../../../x", path.join(d, "escape")));
    const reason = await checkTipTree(hostDeps(), r.repo, r.tipId).then(() => "ok", (error: unknown) => bundleReasonOf(error));
    expect(reason).toBe("symlink");
  });
});
