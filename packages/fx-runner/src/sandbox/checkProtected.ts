/**
 * D#6 R-CHK-2: what the agent's sandbox keeps read-only in a workspace and the check must not change either: the version-control folder and the files the sandbox makes
 * empty stubs for (`SANDBOX_PROTECTED_FILES`: lock files, package-manager and shell settings) plus every `.env` file at the workspace root. One closed list, shared by the
 * check's read-only binds (`hostSandbox.ts`) and by the before/after comparison (`checkStep.ts`).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { SANDBOX_PROTECTED_FILES } from "../daemon/sandboxStubs.js";

const ENV_FILE = /^\.env(?:\..+)?$/;
export const VCS_DIR = ".git";

/** Names at the workspace root that are protected files: the fixed list, and the `.env*` files that exist. */
export function protectedRootNames(workspace: string): string[] {
  const names = new Set<string>(SANDBOX_PROTECTED_FILES);
  try {
    for (const name of readdirSync(workspace)) if (ENV_FILE.test(name)) names.add(name);
  } catch {
    // fx-swallow-ok: a workspace that cannot be listed has no .env files to add; the fixed list still applies
  }
  return [...names].sort();
}

/** The protected paths that exist now, absolute, to be bound read-only. The version-control folder is bound whole. */
export function checkProtected(workspace: string, host: { isDir(target: string): boolean; isFile(target: string): boolean }): string[] {
  const out: string[] = [];
  const vcs = path.join(workspace, VCS_DIR);
  if (host.isDir(vcs) || host.isFile(vcs)) out.push(vcs);
  for (const name of protectedRootNames(workspace)) {
    const target = path.join(workspace, name);
    if (host.isFile(target)) out.push(target);
  }
  return out;
}
