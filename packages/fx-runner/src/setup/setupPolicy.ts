/**
 * D#845 ON-8d: the two closed policies a project setup runs under.
 * EGRESS: the guest starts `deny-all` and is given exactly this template before anything is sent in: the npm registry and the two Python package hosts. No GitHub, no model host, no address literal (the label and PR steps are
 * the cloud's). The hosts are plain DNS names read by the egress proxy's own `parseEgressPolicy`; no rule injects a header.
 * BUNDLE: what comes out of the guest is untrusted, and a refusal has one of four closed reasons: `size`, `symlink`, `path`, `workflow`. The workflow rule is this file's: any change to a `.github/workflows` path (added,
 * changed, deleted or retyped) is refused whatever its content, on lower-cased segments so a case-folding file system cannot get around it. The checks `applyBundle` already makes are mapped here: over a size or count
 * cap is `size`; a link that leaves the tree is `symlink`; anything else wrong with a path, an entry or the bundle's shape is `path`.
 */
import type { NetworkRule } from "../sandbox/port.js";
import type { Git } from "../daemon/git.js";
import { ArchiveRefused } from "../vm/workspace/tar.js";
import { BundleRefused } from "../vm/workspace/bundleHeader.js";
import { BundlePullError } from "../vm/workspace/bundleOut.js";
import { policyOf } from "../vm/sandboxd/microvmSandbox.js";

/** The only hosts a setup's guest may reach. */
export const PROJECT_SETUP_HOSTS: readonly string[] = Object.freeze(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
export const PROJECT_SETUP_NETWORK: readonly NetworkRule[] = Object.freeze(PROJECT_SETUP_HOSTS.map((host) => Object.freeze({ host, purpose: "package_registry" })));
/** The value `updateNetworkPolicy` is given. */
export const projectSetupPolicy = (): unknown => policyOf(PROJECT_SETUP_NETWORK);

export const BUNDLE_REASONS = ["size", "symlink", "path", "workflow"] as const;
export type BundleReason = (typeof BUNDLE_REASONS)[number];

/** The closed reason for any refusal of a bundle, or undefined for an error that is not a bundle refusal (the caller then reports a workspace failure). */
export function bundleReasonOf(error: unknown): BundleReason | undefined {
  if (error instanceof BundleRefused) {
    return error.code === "bundle_too_large" ? "size" : error.detail ?? "path";
  }
  if (error instanceof ArchiveRefused) return error.code === "archive_too_large" ? "size" : error.code === "archive_link" ? "symlink" : "path";
  if (error instanceof BundlePullError) return error.code === "bundle_pull_failed" ? undefined : "size";
  return undefined;
}

/** True for `.github`, `.github/workflows` and anything below it, on lower-cased segments. */
export const isWorkflowPath = (relative: string): boolean => {
  const parts = relative.toLowerCase().split("/");
  return parts[0] === ".github" && (parts.length === 1 || parts[1] === "workflows");
};

/** The hook `applyBundle` runs on the verified tip: lists what the new commits change against the base and refuses any workflow path. Nothing is pushed after a refusal. */
export function workflowPolicy(gitLarge: Git): (input: { repo: string; base: string; tip: string }) => Promise<void> {
  return async ({ repo, base, tip }) => {
    // exactly one commit, directly on the base: finalize makes it, so anything else was made by the guest (and its earlier commits' trees are never checked)
    const parents = (await gitLarge.run("workspace_failed", ["-C", repo, "rev-list", "--parents", `${base}..${tip}`])).split("\n").filter((line) => line !== "");
    if (parents.length !== 1 || parents[0] !== `${tip} ${base}`) throw new BundleRefused("bundle_commits", "path");
    // that commit's own changes, not only the net change: a workflow file added by one commit and removed by the next would still be in the history that is pushed
    const listed = await gitLarge.run("workspace_failed", ["-C", repo, "log", "-z", "--no-renames", "--name-only", "--format=", `${base}..${tip}`]);
    if (listed.split(/[\0\n]/).some((name) => name !== "" && isWorkflowPath(name))) throw new BundleRefused("bundle_tree", "workflow");
  };
}
