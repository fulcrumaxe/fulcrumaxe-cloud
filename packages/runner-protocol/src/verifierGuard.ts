/**
 * D#483 S4-b2a/S4-b2c: the claim verifier's read guard, one text for both places it runs: the cloud's sandbox (`agentConfig.ts` in the
 * runner package) and a local runner's checkout (fx-runner's settings file). Moved here unchanged so the two cannot drift.
 *
 * The verifier role gets Read, Glob and Grep and nothing else. The guard is a PreToolUse command hook that refuses any Read, Glob or Grep
 * whose path, file path, glob or Glob pattern is absolute outside the checkout, climbs with `..`, starts at `~`, holds a backslash, or names
 * `.git` or `.env`, and any Glob pattern with a `{` or `,/` (brace alternation could name an absolute root). It resolves the real location of
 * the Read target and of each Glob/Grep root (`cd -P` / `pwd -P`, the checkout's own real path included) and refuses a link as the last part
 * of a path, anything whose real directory is outside the checkout, and any path whose directory does not resolve. It fails closed: input over
 * `VERIFIER_GUARD_MAX_INPUT` bytes, input it cannot read, another tool, or a path it cannot resolve is refused (exit 2).
 */

/** The role the platform runs to check a proposal's claims. Not in the role manifest. */
export const PROPOSAL_VERIFIER_ROLE = "proposal-verifier";

/** D#483 S4-f1/S4-f4: the role the platform runs to propose changes from a repository's docs and code. Not in the role manifest. Confined exactly as the verifier is. */
export const DISCOVERY_ANALYST_ROLE = "discovery-analyst";

/**
 * D#483 S4-f4 (R-C25-4): the platform roles that are a CONFINED READ-ONLY run (Read under the checkout, Glob and Grep, behind the one read guard). The cloud's
 * sandbox and a local runner both test membership here, never a comparison with one role's name.
 */
export const CONFINED_READ_ROLES: ReadonlySet<string> = new Set([PROPOSAL_VERIFIER_ROLE, DISCOVERY_ANALYST_ROLE]);

/**
 * The verifier's tools as a runner holds them, and as the cloud signs them for a runner job (`role_tools_sha256`): the bare names. The local
 * runner confines each to its own checkout itself (a `Read` rule under the workspace), so the list carries no path.
 */
export const PROPOSAL_VERIFIER_RUNNER_TOOLS: readonly string[] = Object.freeze(["Read", "Glob", "Grep"]);

/**
 * The most hook input the guard looks at, in bytes (the script sets `LC_ALL=C`, so `${#j}` counts bytes under every shell, not characters).
 * The prefix removals (`${t#*...}`) cost time that grows with the square of the input under bash, and the guard now fails closed when the
 * hook runs past its timeout (a slow run would block a legitimate read), so the input is bounded before any match. 8 KB is twice the longest
 * path a file system holds (PATH_MAX, 4096) plus the roughly 500 bytes of fields the CLI wraps around it. The worst shape, a run of escaped
 * quotes, took about 1.6 s at the earlier 32 KB cap and takes about 0.1 s at this one (median of ten runs on the team's host).
 */
export const VERIFIER_GUARD_MAX_INPUT = 8192;

/**
 * The hook script (POSIX sh, builtins only). It holds no single quote, so it is passed whole to `sh -c '...'`. Its one argument (`$1`) is the
 * checkout, the directory it confines to and resolves relative paths from.
 */
export const VERIFIER_READ_GUARD_SCRIPT = `LC_ALL=C; export LC_ALL
exec 2>/dev/null
W=$1
[ -n "$W" ] || exit 2
q=\\"
j=; while IFS= read -r l || [ -n "$l" ]; do j="$j$l"; [ \${#j} -le ${VERIFIER_GUARD_MAX_INPUT} ] || exit 2; done
[ \${#j} -le ${VERIFIER_GUARD_MAX_INPUT} ] || exit 2
R=$(cd -P -- "$W" && pwd -P) || exit 2
cd -- "$R" || exit 2
n=; for x in Read Glob Grep; do case $j in *"$q"tool_name"$q":"$q$x$q"*) n=$x ;; esac; done
[ -n "$n" ] || exit 2
case $j in *"$q"tool_input"$q":{*) ;; *) exit 2 ;; esac
t=\${j#*"$q"tool_input"$q":\\{}; t=\${t%%\\},"$q"tool_use_id"$q"*}
k="file_path path glob"; [ "$n" = Glob ] && k="$k pattern"
fp=; p=; g=
for f in $k; do
  case $t in *"$q$f$q":*) ;; *) continue ;; esac
  v=\${t#*"$q$f$q":}
  case $v in "$q"*) ;; *) exit 2 ;; esac
  v=\${v#"$q"}; v=\${v%%"$q"*}
  case $v in *..*|"~"*|*"\\\\"*|.git|.git/*|*/.git|*/.git/*|.env*|*/.env*) exit 2 ;; esac
  case $v in /*) case $v in "$W"|"$W"/*) ;; *) exit 2 ;; esac ;; esac
  case $f in file_path) fp=$v ;; path) p=$v ;; pattern) case $v in *"{"*|*,/*) exit 2 ;; esac; g=$v ;; esac
done
in_tree() {
  x=$1; [ -n "$x" ] || x=.
  case $x in "$W") x=$R ;; "$W"/*) x=$R/\${x#"$W"/} ;; esac
  [ -L "$x" ] && exit 2
  if [ -d "$x" ]; then d=$x; else case $x in */*) d=\${x%/*} ;; *) d=. ;; esac; fi
  [ -n "$d" ] || exit 2
  r=$(cd -P -- "$d" && pwd -P) || exit 2
  case $r in "$R"|"$R"/*) ;; *) exit 2 ;; esac
}
case $n in
  Read) in_tree "$fp" ;;
  Grep) in_tree "$p" ;;
  Glob)
    in_tree "$p"
    b=\${g%%[*?[]*}
    if [ "$b" != "$g" ]; then case $b in */*) b=\${b%/*} ;; *) b= ;; esac; fi
    if [ -n "$b" ]; then case $b in /*) in_tree "$b" ;; *) in_tree "\${p:-.}/$b" ;; esac; fi ;;
esac
exit 0
`;

/** A checkout path the hook command can carry unquoted: absolute, plain characters only, no `.` or `..` segment, no trailing slash. */
const SAFE_CHECKOUT = /^(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)+$/;
export const isGuardableCheckout = (dir: string): boolean => SAFE_CHECKOUT.test(dir) && !dir.split("/").some((s) => s === "." || s === "..");

/**
 * The hook's command line for one checkout. Throws (so no settings are written and the run does not start) when the checkout is not a plain
 * absolute path or the script could not be single-quoted.
 */
export function verifierGuardCommand(checkout: string): string {
  if (!isGuardableCheckout(checkout)) throw new Error("verifier guard: the checkout is not a plain absolute path");
  if (VERIFIER_READ_GUARD_SCRIPT.includes("'")) throw new Error("verifier guard: the script cannot be quoted");
  return `/bin/sh -c '${VERIFIER_READ_GUARD_SCRIPT}' fx-read-guard ${checkout}`;
}

/**
 * The PreToolUse hook entry for one checkout. By default the CLI lets a tool call through when a command hook times out, cannot start, or
 * exits with a code other than 0 or 2. `onFailure: "block"` (Claude Code 2.1.295 or later) makes each of those refuse the call, as exit 2
 * does, so the guard fails closed even when it is killed at its `timeout` or crashes. Both places that run the guard need a CLI that honours
 * it: the sandbox image pins at least 2.1.295 (versions.lock.json) and a local runner's minimum is 2.1.295 (fx-runner's `MIN_CLAUDE_VERSION`).
 */
export function verifierReadGuardHook(checkout: string): { matcher: string; hooks: Array<{ type: "command"; command: string; timeout: number; onFailure: "block" }> } {
  return { matcher: "Read|Glob|Grep", hooks: [{ type: "command", command: verifierGuardCommand(checkout), timeout: 5, onFailure: "block" }] };
}
