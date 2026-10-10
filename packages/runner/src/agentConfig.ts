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
 *  - every other role (the panel seats, the project manager and the like): read, curl (reads of GitHub, which the proxy
 *    allows them), git and read-only helpers.
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
});

/** The tool allow list for a role; a role not named above gets the look-only list. */
export function toolsForRole(role: string): readonly string[] {
  return Object.hasOwn(TOOLS_BY_ROLE, role) ? TOOLS_BY_ROLE[role]! : OTHER_ROLE_TOOLS;
}

/**
 * The settings file for one role: the runner's hook, the role's allow list and `defaultMode: "dontAsk"`. The same bytes
 * are written before a fresh run and before a resumed one, so a resume has exactly the permissions of a start.
 */
export function agentSettingsFor(role: string): Record<string, unknown> {
  return { ...FX_AGENT_SETTINGS, permissions: { defaultMode: "dontAsk", allow: [...toolsForRole(role)], deny: [] as string[] } };
}

/**
 * W-1/W-2: prints the advisory `additionalContext` from precomputed values in
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
msg=
[ -n "$t" ] && msg="About $t minutes remain in this run. If the work will not finish, end with a checkpoint envelope: verdict checkpoint and a short summary of what is done and what is left."
[ -n "$c" ] && msg="$msg Only $c model calls remain in this run; if the work will not finish, end with the same checkpoint envelope."
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
}): string {
  return JSON.stringify({
    started_epoch_s: Math.floor(p.startedMs / 1000),
    deadline_epoch_s: Math.floor(p.deadlineMs / 1000),
    max_model_calls: p.maxModelCalls,
    ...(p.timeWarningMinutes === undefined ? {} : { time_warning_minutes: p.timeWarningMinutes }),
    ...(p.modelCallsRemaining === undefined ? {} : { model_calls_remaining: p.modelCallsRemaining }),
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
