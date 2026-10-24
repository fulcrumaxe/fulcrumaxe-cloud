import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The home directory of a check (D#6, the live run of 10-24): a fresh, empty one inside the job's own temp directory, holding the package-manager settings the check must have for every
 * pnpm command a TEST starts inside it.
 *
 * Why a home and not environment names: a test that builds a package (a `pnpm --filter ops build`, a `pnpm exec next build`) passes pnpm a short allowlist of names, so everything `CHECK_PNPM_ENV`
 * gives the check itself (offline, the release-age skip) is dropped on the way. `HOME` is on every such list, because the package manager and its scripts need it, and pnpm looks for its user-level
 * settings in the folder `.config/pnpm` under the home, and the user's `.npmrc` in the home itself. With the real home, which the sandbox hides, the nested pnpm gets a permission error on that
 * `.npmrc` and no settings at all; it then compares the tree with the lockfile before it runs the script (`verifyDepsBeforeRun`, on by default in pnpm 11), finds a store or a state that differs from
 * the one the runner installed with, and starts a `pnpm install`: it asks the registry (there is no network), or wants to delete `node_modules` and stops on a prompt with no terminal.
 *
 * The file turns that off (`verifyDepsBeforeRun: false`: the check never installs; the runner installed before it, on the host, with network), keeps the release-age skip the check itself has
 * (`minimumReleaseAge: 0`), and names the job's package store (`storeDir`) so a nested command that reads the store reads the one the install used. `offline` and `confirmModulesPurge` cannot be set in
 * a user-level file (pnpm refuses them there) and are left alone on purpose: with `CI=true` or `confirmModulesPurge: false` a nested `pnpm install` would delete `node_modules` without asking, which is
 * worse than the named error it gives now. The empty `.npmrc` is the user config: none of the host user's registry settings or tokens, which the sandbox hides anyway.
 *
 * It is all inside the job's own temp directory, which the check can write anyway: nothing here widens the sandbox or gives it a network. The home is the check's only; the agent's own
 * session is not touched.
 */

/**
 * Makes the home (a name the job cannot have chosen: `mkdtemp` never reuses one, so nothing the agent planted in the temp directory, a link included, is followed or written through; mode
 * 0700) with its two files (created with `wx`), and returns its path. Throws when any of it cannot be made.
 */
export function prepareCheckHome(tempDir: string, storeDir: string | undefined): string {
  const home = mkdtempSync(path.join(tempDir, "fx-check-home-"));
  const config = path.join(home, ".config", "pnpm");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const lines = ["verifyDepsBeforeRun: false", "minimumReleaseAge: 0"];
  if (storeDir !== undefined) lines.push(`storeDir: ${JSON.stringify(storeDir)}`);
  writeFileSync(path.join(config, "config.yaml"), `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(home, ".npmrc"), "", { flag: "wx", mode: 0o600 });
  return home;
}
