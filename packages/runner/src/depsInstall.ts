import { SANDBOX_CA_ENV } from "./sandboxEnv.js";
import type { NetworkPolicyRule } from "./networkPolicy.js";

/**
 * The install-phase firewall is the registries and nothing else. The policy builders return the run policy plus the registries
 * (model host with the key injected, GitHub proxy); the install keeps only the registry rules, so a lifecycle script cannot reach
 * the model host or the proxy during the install window.
 */
export function registryOnly(rules: readonly NetworkPolicyRule[]): NetworkPolicyRule[] {
  return rules.filter((r) => r.purpose === "package_registry");
}

/**
 * D#6 C44-6b: the dependency install a cloud run does after the clone and before the agent starts.
 *
 * Same behaviour as the local runner's install note: a regular, non-empty `pnpm-lock.yaml` means
 * `pnpm install --frozen-lockfile`, otherwise a regular, non-empty `package-lock.json` means `npm ci`, otherwise
 * nothing happens at all (no network change, no command). The install is its own sandbox command, run under the
 * install-phase firewall; the port puts the run-phase firewall back before the agent command exists.
 *
 * Both scripts are fixed text. The only value that reaches them is the manager name, as a positional argument.
 */

/** How long the install command may run before it is killed and counted as failed. */
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The end of the install output the port holds while it runs; the redacted tail kept on a failure is cut from it. */
export const INSTALL_OUTPUT_BUFFER_CHARS = 4096;
export const INSTALL_TAIL_MAX_CHARS = 500;

/** Exit codes of the detect script. */
export const DETECT_NONE = 10;
export const DETECT_PNPM = 11;
export const DETECT_SKIP = 12;
export const DETECT_NPM = 13;
/** A lockfile over `MAX_LOCKFILE_BYTES`: not read, not installed from; reported as a failed install. */
export const DETECT_TOO_BIG = 14;
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;

/** The marker the install leaves inside `node_modules` once it succeeded: `<manager>:<sha256 of the lockfile>`. */
export const LOCK_MARKER = "node_modules/.fx-lockhash";

/**
 * Runs in the workspace (`$1`; `$2` is `resume` or `fresh`; a workspace that does not exist has no lockfile). A lockfile counts only as a regular, non-empty file that is not a link. A workspace whose
 * `node_modules` carries the marker for the same manager and lockfile hash is skipped (a resumed run).
 */
export const DETECT_SCRIPT = [
  'cd "$1" 2>/dev/null || exit ' + DETECT_NONE,
  'if [ -f pnpm-lock.yaml ] && [ ! -L pnpm-lock.yaml ] && [ -s pnpm-lock.yaml ]; then m=pnpm; f=pnpm-lock.yaml',
  'elif [ -f package-lock.json ] && [ ! -L package-lock.json ] && [ -s package-lock.json ]; then m=npm; f=package-lock.json',
  `else exit ${DETECT_NONE}; fi`,
  `if [ "$(wc -c < "$f")" -gt ${MAX_LOCKFILE_BYTES} ]; then exit ${DETECT_TOO_BIG}; fi`,
  'h=$(sha256sum "$f" | cut -d" " -f1) || exit 1',
  // The marker counts only on a resumed workspace ($2 = resume): on a fresh run the repo could ship its own.
  `if [ "$2" = resume ] && [ -f ${LOCK_MARKER} ] && [ ! -L ${LOCK_MARKER} ] && [ "$(cat ${LOCK_MARKER})" = "$m:$h" ]; then exit ${DETECT_SKIP}; fi`,
  `if [ "$m" = pnpm ]; then exit ${DETECT_PNPM}; fi`,
  `exit ${DETECT_NPM}`,
].join("\n");

/** `$1` is the workspace, `$2` is `pnpm` or `npm`; the lockfile is never rewritten (frozen install, `npm ci`). */
export const INSTALL_SCRIPT = [
  "set -e",
  'cd "$1"',
  'case "$2" in',
  // The settings are flags as well as env: a repo's own workspace settings cannot outrank a command-line flag.
  '  pnpm) pnpm install --frozen-lockfile --config.manage-package-manager-versions=false --config.store-dir="$1/node_modules/.pnpm-store" --config.cache-dir="$1/node_modules/.pnpm-cache" ;;',
  '  npm) npm ci --cache "$1/node_modules/.npm-cache" --no-fund --no-audit --no-update-notifier ;;',
  "  *) exit 2 ;;",
  "esac",
  'if [ "$2" = pnpm ]; then f=pnpm-lock.yaml; else f=package-lock.json; fi',
  'h=$(sha256sum "$f" | cut -d" " -f1)',
  "mkdir -p node_modules",
  `printf '%s' "$2:$h" > ${LOCK_MARKER}`,
].join("\n");

/** The fixed prompt lines. Runner text; nothing from the job or the install output is in them. */
export const DEPS_INSTALLED_LINE = "Dependencies were installed from the lockfile before this run started.";
export const DEPS_FAILED_LINE =
  "Dependencies were not installed (deps_install_failed). Report what you could not verify because of it, with the error; do not try to get around the network rules.";

export type DepsOutcome = "none" | "skipped" | "installed" | "failed";

/** The prompt line for an outcome, or undefined when the repo has no lockfile and nothing is said. */
export function depsPromptLine(outcome: DepsOutcome): string | undefined {
  if (outcome === "installed" || outcome === "skipped") return DEPS_INSTALLED_LINE;
  if (outcome === "failed") return DEPS_FAILED_LINE;
  return undefined;
}

/**
 * The install command's env: the system CA variables, a fixed set of tool settings, and caches under the
 * workspace's own `node_modules`. No variable from the run's env is copied, so no model-key slot, token or
 * customer value can reach it. `manage-package-manager-versions=false` stops pnpm fetching another pnpm into the
 * home directory; the store and cache sit in the workspace so nothing is installed outside it.
 */
export function installEnv(workdir: string): Record<string, string> {
  return {
    ...SANDBOX_CA_ENV,
    CI: "true",
    npm_config_store_dir: `${workdir}/node_modules/.pnpm-store`,
    npm_config_cache: `${workdir}/node_modules/.npm-cache`,
    npm_config_manage_package_manager_versions: "false",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
}
