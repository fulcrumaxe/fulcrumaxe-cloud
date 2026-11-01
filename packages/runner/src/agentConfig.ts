/**
 * D#2 H14c-SS (C59): the only configuration the sandbox's print-mode agent loads.
 *
 * The agent reads settings and MCP servers ONLY from these files, which the
 * runner writes before every agent command at an absolute path outside the
 * workspace; the argv (`SANDBOX_AGENT_COMMAND`) names them and excludes every
 * filesystem settings source, so a customer's `.claude/settings.json`,
 * `.claude/settings.local.json` and `.mcp.json` are never read. Tool approvals
 * from a role's toolset were NOT here (D#47 M02 was to add them).
 * C66: the settings held the runner's own limit-warning hook, and nothing else.
 *
 * OWNER RULING R-C44-1 (2026-10-10) amends D#483 P3 for the executor and the review roles: plain `Bash` (see EXECUTOR_TOOLS).
 * OWNER RULING (D#483 P3, 2026-10-03; amends C59 SS-CONTENT and C66): the settings now ALSO carry, per role, an explicit
 * tool allow list and `defaultMode: "dontAsk"`, the same for a fresh run and a resumed one (`agentSettingsFor`). Found
 * live: a fresh print-mode run had relied on the CLI's implicit default (auto mode), and a RESUMED run (an executor fix
 * round) was refused every edit and git command, because that default does not carry over to `--resume`. With
 * `dontAsk`, anything not on the role's list is refused rather than asked about, so a run can neither stall on a prompt
 * nor use a tool its role was not given. The boundary that matters is still the sandbox VM, the egress firewall and the
 * gh-proxy's push and PR rules; these lists are least privilege on top of them, not a replacement.
 */
import { CONFINED_READ_ROLES, CONTEXT_WARNING_CODE, CONTEXT_WARNING_TEXT, CONTEXT_WARN_PCT, DISCOVERY_ANALYST_ROLE, PROPOSAL_VERIFIER_ROLE, PROPOSAL_VERIFIER_RUNNER_TOOLS, excludeDenyRules, verifierReadGuardHook } from "@fulcrumaxe/runner-protocol";
// D#600 CX-5c: the exclude helpers live in the protocol package, so the local runner writes the very same rules. Re-exported here under the names this package always had.
export { EXCLUDE_PROMPT_LINE, MAX_EXCLUDE_RULES, disabledToolsFor, escapeRulePath, excludeDenyRules } from "@fulcrumaxe/runner-protocol";

export const FX_AGENT_CONFIG_DIR = "/fx/agent-config";
export const FX_AGENT_SETTINGS_PATH = `${FX_AGENT_CONFIG_DIR}/settings.json`;
export const FX_AGENT_MCP_PATH = `${FX_AGENT_CONFIG_DIR}/mcp.json`;
/** C66: the runner's ONE hook script, and the file it reads (both rewritten before every command). */
export const FX_LIMIT_HOOK_PATH = `${FX_AGENT_CONFIG_DIR}/limit-hook.sh`;
export const FX_RUN_LIMITS_PATH = "/fx/run-limits.json";
/** Mode 0444 is not executable, so the interpreter is named by absolute path. */
export const FX_LIMIT_HOOK_COMMAND = `/bin/sh ${FX_LIMIT_HOOK_PATH}`;

/**
 * C66 (amends C59 SS-CONTENT): the BASE every role's settings start from. The single hook is the runner's own script;
 * no env, apiKeyHelper, plugins, model or statusLine. No `matcher`: it fires on every tool. The permissions are empty
 * here; `agentSettingsFor` adds the role's allow list and `defaultMode` (owner ruling, see the header).
 */
export const FX_AGENT_SETTINGS = {
  disableAllHooks: false,
  hooks: { PostToolUse: [{ hooks: [{ type: "command", command: FX_LIMIT_HOOK_COMMAND, timeout: 5 }] }] },
  permissions: { allow: [] as string[], deny: [] as string[] },
} as const;

/** Reading the checkout: no write, no network. */
const READ_TOOLS = ["Read", "Glob", "Grep", "LS"] as const;
/** The read-only helpers of a role that only looks. */
const LOOK_HELPERS = ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(pwd)"] as const;

/**
 * Per role, the exact tools the agent may use (anything else is refused; see `agentSettingsFor`):
 *  - executor: read, edit and write files, and plain `Bash` (R-C44-1: the VM, the egress firewall and the gh-proxy's push
 *    and PR rules are the boundary; the proxy decides what each GitHub request may do).
 *  - the reviewers (code, security), acceptance-tester and debater: read and plain `Bash`, so they can run the tests.
 *    NO edit or write tool. They can still write files from the shell, so the guarantee that matters is that a
 *    reviewer's changes are never published: the gh-proxy refuses a reviewer push and the workspace is discarded.
 *  - the other roles of the role manifest (the panel seats, the project manager and the like), each named below: read,
 *    curl (reads of GitHub, which the proxy allows them), git and read-only helpers.
 *  - the platform roles (`PLATFORM_ROLES`, not in the manifest): the claim verifier's confined list (`PROPOSAL_VERIFIER_ROLE`).
 *  - a role that is not named here gets NOTHING: `toolsForRole` throws `UnknownRoleError` (code `unknown_role`), so no
 *    settings file is written and the run does not start. There is no fallback list; a new role must be added here.
 */
export const EXECUTOR_TOOLS: readonly string[] = Object.freeze([...READ_TOOLS, "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);
export const REVIEWER_TOOLS: readonly string[] = Object.freeze([...READ_TOOLS, "Bash"]);
export const OTHER_ROLE_TOOLS: readonly string[] = Object.freeze([...READ_TOOLS, "Bash(curl:*)", "Bash(git:*)", ...LOOK_HELPERS]);

const TOOLS_BY_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  executor: EXECUTOR_TOOLS,
  "code-reviewer": REVIEWER_TOOLS,
  "security-reviewer": REVIEWER_TOOLS,
  "acceptance-tester": REVIEWER_TOOLS,
  debater: REVIEWER_TOOLS,
  "project-manager": OTHER_ROLE_TOOLS,
  "technical-architect": OTHER_ROLE_TOOLS,
  "product-owner": OTHER_ROLE_TOOLS,
  "cost-analyst": OTHER_ROLE_TOOLS,
  "performance-expert": OTHER_ROLE_TOOLS,
  "security-expert": OTHER_ROLE_TOOLS,
  researcher: OTHER_ROLE_TOOLS,
  "feedback-scanner": OTHER_ROLE_TOOLS,
  "incident-commander": OTHER_ROLE_TOOLS,
  "browser-tester": OTHER_ROLE_TOOLS,
  "tui-tester": OTHER_ROLE_TOOLS,
  "docs-writer": OTHER_ROLE_TOOLS,
  "release-manager": OTHER_ROLE_TOOLS,
  "runbook-writer": OTHER_ROLE_TOOLS,
  "accessibility-reviewer": OTHER_ROLE_TOOLS,
  "ux-designer": OTHER_ROLE_TOOLS,
  "mission-analyst": OTHER_ROLE_TOOLS,
  "run-analyst": OTHER_ROLE_TOOLS,
  "analytics-engineer": OTHER_ROLE_TOOLS,
  "visual-verifier": OTHER_ROLE_TOOLS,
  "quality-sweep": OTHER_ROLE_TOOLS,
});

/** D#483 S4-f1: the role the platform runs to propose changes from a repository's docs and code. Not in the role manifest. Hosted half only; the runner half is S4-f4. */
export { DISCOVERY_ANALYST_ROLE };

/**
 * D#483 S4-f1 (R-C25-4): the platform roles that are a CONFINED READ-ONLY run: Read under the checkout, Glob and Grep, behind the one read guard.
 * Every test that means "a confined read-only platform role" is a test of membership here, never a comparison with one role's name. A comparison
 * with `PROPOSAL_VERIFIER_ROLE` alone is for something only the verifier does (it cites lines and is the one role a runner job can be for today)
 * and says why in a comment (confinedRoles.test.ts holds the line).
 */
export { CONFINED_READ_ROLES };

/**
 * The roles the platform itself runs that are not in the role manifest, each with its own settings below (today only the
 * claim verifier, `PROPOSAL_VERIFIER_ROLE`, and the discovery analyst, `DISCOVERY_ANALYST_ROLE`). Named here so the manifest parity check can allow exactly these and nothing else.
 */
export const PLATFORM_ROLES: readonly string[] = Object.freeze([PROPOSAL_VERIFIER_ROLE, DISCOVERY_ANALYST_ROLE]);

/** The roles that have a tool list: the table's, in table order, then the platform roles. Every other name is refused by `toolsForRole`. */
export const TOOL_LISTED_ROLES: readonly string[] = Object.freeze([...Object.keys(TOOLS_BY_ROLE), ...PLATFORM_ROLES]);

/** Thrown for a role with no entry in the tool table. Nothing is written or started for it. */
export class UnknownRoleError extends Error {
  readonly code = "unknown_role";
  constructor(role: unknown) {
    super(`no tool list for role ${JSON.stringify(String(role)).slice(0, 80)}`);
    this.name = "UnknownRoleError";
  }
}

/**
 * The tool allow list for a role. Fails closed: a role not named above throws `UnknownRoleError`; there is no fallback
 * list. Own-property lookup only, so names like `constructor` and `__proto__` are unknown too.
 */
export function toolsForRole(role: string): readonly string[] {
  if (CONFINED_READ_ROLES.has(role)) return VERIFIER_ALLOW;
  if (typeof role !== "string" || !Object.hasOwn(TOOLS_BY_ROLE, role)) throw new UnknownRoleError(role);
  return TOOLS_BY_ROLE[role]!;
}

/**
 * D#483 S4-b2c: the tool list a runner job of this role is signed with (`role_tools_sha256`). The same as `toolsForRole`, except for the claim
 * verifier: its sandbox list names the sandbox's checkout path, so a runner job carries the bare three (`PROPOSAL_VERIFIER_RUNNER_TOOLS`), which
 * the runner confines to its own checkout. Fails closed like `toolsForRole`.
 */
export function runnerToolsForRole(role: string): readonly string[] {
  return CONFINED_READ_ROLES.has(role) ? PROPOSAL_VERIFIER_RUNNER_TOOLS : toolsForRole(role);
}

/**
 * D#483 S4-b2a: the claim verifier. Its prompt holds an outsider's text and its claims are stored and shown, so whatever it can read
 * it can leak. It gets Read, Glob and Grep and nothing else (no Bash, no LS, no network), confined three ways:
 *  - Read is allowed only under the checkout (`VERIFIER_WORKDIR`, where the run clones the repository), never bare;
 *  - deny rules (which win over any allow) cover the checkout's `.git` and `.env*` files and the places outside it a secret could sit;
 *  - a PreToolUse hook (`VERIFIER_READ_GUARD`) refuses any Read, Glob or Grep whose path, file path, glob or Glob pattern is absolute outside
 *    the checkout, climbs with `..`, starts at `~`, holds a backslash, or names `.git` or `.env`, and any Glob pattern with a `{` or `,/`
 *    (brace alternation could name an absolute root). The CLI does not limit Glob and Grep to a path by rule (CX-5b), so the hook is what
 *    keeps those two in the tree. It fails closed: input over `VERIFIER_GUARD_MAX_INPUT` bytes, input it cannot read, another tool,
 *    or a path it cannot resolve is refused (exit 2).
 * The rules and the hook's lexical checks see names, not files. A symlink committed in the repository could name a place outside the tree
 * by a relative, in-tree name. Two things stop that: the clone writes every link as a plain file (`core.symlinks=false`, repoClone.ts), and,
 * as a second layer, the hook resolves the real location of the Read target and of each Glob/Grep root (`cd -P` / `pwd -P`, the checkout's
 * own real path included) and refuses a link as the last part of a path, anything whose real directory is outside the checkout, and any
 * path whose directory does not resolve.
 * Underneath all of it, the sandbox holds no secret by construction (sandboxEnv.ts: credentials are brokered at the firewall).
 */
export { PROPOSAL_VERIFIER_ROLE };
export const VERIFIER_WORKDIR = "/vercel/sandbox/repo";
const VERIFIER_ALLOW: readonly string[] = Object.freeze([`Read(/${VERIFIER_WORKDIR}/**)`, "Glob", "Grep"]);
export const VERIFIER_DENY: readonly string[] = Object.freeze([
  ...[".git", ".git/**", "**/.git", "**/.git/**", ".env*", "**/.env*"].map((p) => `Read(/${VERIFIER_WORKDIR}/${p})`),
  ...["proc", "sys", "dev", "etc", "fx", "root", "home", "tmp", "run", "var"].map((d) => `Read(//${d}/**)`),
  "Read(~/**)",
]);
/**
 * The guard's text, its input bound and its hook entry live in @fulcrumaxe/runner-protocol (verifierGuard.ts), so a local runner runs the very
 * same script (S4-b2c). Re-exported here under the names this package always had.
 * The hook entry carries `onFailure: "block"` (set in the shared helper), so a timeout or crash refuses the call; see verifierGuard.ts.
 */
export { VERIFIER_GUARD_MAX_INPUT, VERIFIER_READ_GUARD_SCRIPT } from "@fulcrumaxe/runner-protocol";
export const VERIFIER_READ_GUARD = verifierReadGuardHook(VERIFIER_WORKDIR);

/**
 * The settings file for one role: the runner's hook, the role's allow list and `defaultMode: "dontAsk"`. The same bytes
 * are written before a fresh run and before a resumed one, so a resume has exactly the permissions of a start.
 */
export function agentSettingsFor(role: string, excludes: readonly string[] = []): Record<string, unknown> {
  if (CONFINED_READ_ROLES.has(role)) {
    return {
      ...FX_AGENT_SETTINGS,
      hooks: { ...FX_AGENT_SETTINGS.hooks, PreToolUse: [VERIFIER_READ_GUARD] },
      permissions: { defaultMode: "dontAsk", allow: [...VERIFIER_ALLOW], deny: [...VERIFIER_DENY, ...excludeDenyRules(excludes)] },
    };
  }
  return { ...FX_AGENT_SETTINGS, permissions: { defaultMode: "dontAsk", allow: [...toolsForRole(role)], deny: excludeDenyRules(excludes) } };
}

/**
 * D#600 CX-6a: the three advisory warnings the hook can print. Each has its own code (the name a test or a label keys on) and its own text, so a time
 * or call warning can never be mistaken for the context one. `{N}` is the number. A text holds no quote, backslash, dollar sign or backtick: it goes
 * into the shell script and the hook's JSON as it is.
 */
export const LIMIT_WARNING_CODES = { time: "time_warning", calls: "calls_warning", context: CONTEXT_WARNING_CODE } as const;
export type LimitWarningCode = (typeof LIMIT_WARNING_CODES)[keyof typeof LIMIT_WARNING_CODES];
export const LIMIT_WARNING_TEXT: Readonly<Record<LimitWarningCode, string>> = Object.freeze({
  time_warning: "About {N} minutes remain in this run. If the work will not finish, end with a checkpoint envelope: verdict checkpoint and a short summary of what is done and what is left.",
  calls_warning: "Only {N} model calls remain in this run; if the work will not finish, end with the same checkpoint envelope.",
  context_warning: CONTEXT_WARNING_TEXT,
});
/** The text a warning prints for `n`. */
export function limitWarningText(code: LimitWarningCode, n: number): string {
  return LIMIT_WARNING_TEXT[code].replace("{N}", String(n));
}
/** A text as shell double-quoted text, its `{N}` read from the variable `name`. */
const shellText = (code: LimitWarningCode, name: string): string => LIMIT_WARNING_TEXT[code].replace("{N}", `$${name}`);

/**
 * W-1/W-2/CX-6a: prints the advisory `additionalContext` from precomputed values in
 * `/fx/run-limits.json` (one line the runner writes). It reads only that file
 * and uses shell builtins only: no network, no workdir, no child process, and
 * no clock (the runner rewrites the file when its own timer passes 80%). Each
 * value is used only if it is 1 to 9 plain digits with no leading zero, the
 * first occurrence of a key wins, and any other input exits 0 with no output
 * (stderr is closed). The runner never reads the file or this output back (MP-SRC).
 */
export const FX_LIMIT_HOOK_SCRIPT = `exec 2>/dev/null
f=${FX_RUN_LIMITS_PATH}
j=
[ -r "$f" ] && read -r j < "$f"
v() {
  r=; k="\\"$1\\":"
  case $j in *"$k"*) r=\${j#*"$k"}; r=\${r%%[!0-9]*} ;; esac
  case $r in ""|0?*|??????????*) r= ;; esac
}
v time_warning_minutes; t=$r
v model_calls_remaining; c=$r
v context_pct; p=$r
case $p in ????*) p= ;; esac
[ -n "$p" ] && [ "$p" -lt ${CONTEXT_WARN_PCT} ] && p=
msg=
[ -n "$t" ] && msg="${shellText("time_warning", "t")}"
[ -n "$c" ] && msg="$msg ${shellText("calls_warning", "c")}"
[ -n "$p" ] && msg="$msg ${shellText("context_warning", "p")}."
[ -n "$msg" ] && printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\\n' "$msg"
exit 0
`;

/** The `/fx/run-limits.json` body (one line): numbers only, no secret or token. `timeWarningMinutes` appears once the runner's clock passes 80% of the window, `modelCallsRemaining` from 80% of the call limit. */
export function runLimitsFileContent(p: {
  startedMs: number;
  deadlineMs: number;
  maxModelCalls: number;
  timeWarningMinutes?: number;
  modelCallsRemaining?: number;
  /** CX-6a: whole percent of the model's window the latest turn fills; the runner passes it only from CONTEXT_WARN_PCT up. */
  contextPct?: number;
}): string {
  return JSON.stringify({
    started_epoch_s: Math.floor(p.startedMs / 1000),
    deadline_epoch_s: Math.floor(p.deadlineMs / 1000),
    max_model_calls: p.maxModelCalls,
    ...(p.timeWarningMinutes === undefined ? {} : { time_warning_minutes: p.timeWarningMinutes }),
    ...(p.modelCallsRemaining === undefined ? {} : { model_calls_remaining: p.modelCallsRemaining }),
    ...(p.contextPct === undefined ? {} : { context_pct: p.contextPct }),
  });
}

/** No MCP servers at all. */
export const FX_AGENT_MCP_CONFIG = { mcpServers: {} } as const;

/** True when `workdir` is the config directory, under it, or contains it. */
export function overlapsAgentConfigDir(workdir: string): boolean {
  const norm = (p: string): string => {
    const parts: string[] = [];
    for (const seg of `/${p}`.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== "" && seg !== ".") parts.push(seg);
    }
    return `/${parts.join("/")}`;
  };
  const dir = norm(FX_AGENT_CONFIG_DIR);
  const wd = norm(workdir);
  const within = (a: string, b: string): boolean => a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
  return within(wd, dir) || within(dir, wd);
}
