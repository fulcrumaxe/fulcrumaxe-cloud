import { lstatSync } from "node:fs";
import path from "node:path";
import { REVIEW_JOB_ROLES } from "@fulcrumaxe/runner-protocol";

/** The roles that run tests and so are told to install dependencies first (D#6 C44-4): the executor and the four review roles. */
export const TEST_ROLES: ReadonlySet<string> = new Set(["executor", ...REVIEW_JOB_ROLES]);

/** The lockfiles the frozen install reads. A repo without one is not told anything about a registry. */
export const LOCKFILES: readonly string[] = Object.freeze(["pnpm-lock.yaml", "package-lock.json"]);

/** The hosts that count as an npm registry in a job's sandbox domains. A private registry is not recognised, and so is reported as missing. */
export const NPM_REGISTRY_HOSTS: ReadonlySet<string> = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

/** The closed detail the runner records when a lockfile is present and no npm registry host is allowed. */
export type DepsDetail = "deps_registry_not_allowed" | "deps_lockfile_refused";

/**
 * True when `workspace` holds a lockfile at its root: a regular, non-empty file, looked at without following a link. The empty
 * file is excluded because the agent sandbox makes an empty stub for every lockfile name (see `sandboxStubs.ts`), so on a kept
 * workspace an empty one says nothing about the repo.
 */
export function hasLockfile(workspace: string): boolean {
  return LOCKFILES.some((name) => {
    try {
      const stat = lstatSync(path.join(workspace, name));
      return stat.isFile() && stat.size > 0;
    } catch {
      // fx-swallow-ok: a missing or unreadable lockfile means "no lockfile"; nothing about it is reported
      return false;
    }
  });
}

/** True when the job's sandbox domains hold an npm registry host (compared in lower case). */
export function hasNpmRegistry(domains: readonly string[]): boolean {
  return domains.some((domain) => NPM_REGISTRY_HOSTS.has(domain.toLowerCase()));
}

/** The detail for a job, or undefined: only a test role, only a workspace with a lockfile, only when no registry host is allowed. */
export function depsDetail(input: { role: string; workspace: string; domains: readonly string[] }): "deps_registry_not_allowed" | undefined {
  if (!TEST_ROLES.has(input.role) || hasNpmRegistry(input.domains) || !hasLockfile(input.workspace)) return undefined;
  return "deps_registry_not_allowed";
}

/** The registry host the host-side install is pinned to: the first npm registry host the job's domains allow (npmjs before yarnpkg), lower case; undefined when none. */
export function registryHostOf(domains: readonly string[]): string | undefined {
  const lower = domains.map((domain) => domain.toLowerCase());
  return ["registry.npmjs.org", "registry.yarnpkg.com"].find((host) => lower.includes(host));
}
