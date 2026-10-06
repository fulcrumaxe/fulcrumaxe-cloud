/**
 * The hosted tool registry: every tool name a card in `cards/*.md` is
 * allowed to reference, and what engine-era script (if any) it replaced.
 *
 * This is the answer to the porting task: each card's references to the
 * engine's own scripts (`spawn-agent.sh`, `preflight.sh`, `gh-label.sh`,
 * `control_plane.py`, `rotate-team-log.sh`, `post-*-hook.sh`,
 * `consensus_panel.py`, `repo-resolve.sh`, `verify-repo-plane-divergence.sh`,
 * ...) had to become either a hosted tool name below, or nothing at all
 * (a step the orchestrator now does without the role's help). There is no
 * per-role spawn template file, no local Team Log, and no local control
 * plane to query — those are gone, not renamed.
 */

export interface ToolRegistryEntry {
  /** The literal token a card uses to reference this tool. */
  name: string;
  /** One line: what it does in the hosted product. */
  description: string;
  /** The engine-era script(s) this replaced, if any ("none" for a tool that
   *  already existed in the engine unchanged, e.g. Read/Write/Bash). */
  replaces: string;
}

export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  {
    name: "gh",
    description:
      "GitHub CLI. Every call is already scoped to the tenant's one installed repo by the " +
      "platform's GitHub proxy (H13) — no --repo flag, no CODE_REPO resolution ceremony.",
    replaces: "scripts/lib/repo-resolve.sh, scripts/lib/gh-label.sh, the --repo ceremony",
  },
  {
    name: "git",
    description:
      "Plain git operations inside the role's sandbox. The GitHub proxy enforces that a push " +
      "from the executor only ever lands on refs/heads/fx/* (H03) — no role-side check needed.",
    replaces: "none (unchanged)",
  },
  {
    name: "Bash",
    description: "Run a shell command inside the role's own sandbox.",
    replaces: "none (unchanged)",
  },
  {
    name: "Read",
    description: "Read a file inside the role's own sandbox.",
    replaces: "none (unchanged)",
  },
  {
    name: "Glob",
    description: "Find files by name pattern inside the role's own sandbox.",
    replaces: "none (unchanged)",
  },
  {
    name: "Grep",
    description: "Search file contents inside the role's own sandbox.",
    replaces: "none (unchanged)",
  },
  {
    name: "Write",
    description: "Write a file inside the role's own sandbox (denied to read-only roles).",
    replaces: "none (unchanged)",
  },
  {
    name: "Edit",
    description: "Edit a file inside the role's own sandbox (denied to read-only roles).",
    replaces: "none (unchanged)",
  },
  {
    name: "NotebookEdit",
    description: "Edit a Jupyter notebook cell (denied to read-only roles, same as Edit).",
    replaces: "none (unchanged)",
  },
  {
    name: "WebFetch",
    description: "Fetch and read a specific URL. Researcher-only.",
    replaces: "none (unchanged)",
  },
  {
    name: "WebSearch",
    description: "Issue a web search query. Researcher-only.",
    replaces: "none (unchanged)",
  },
  {
    name: "Agent",
    description:
      "Not available to any ported role. Spawning is orchestrator-only in the hosted design — " +
      "there is no role-callable spawn tool, not even for the project-manager. A role that wants " +
      "another role started says so via next_role_request instead.",
    replaces: "none (this tool simply does not exist here)",
  },
  {
    name: "fx test",
    description:
      "Runs lint + typecheck + test + build for the tenant's repo in one call, with a " +
      "lint-skip mode when the tenant's role_settings turns lint_must_pass off.",
    replaces: "scripts/preflight.sh, scripts/preflight-fast.sh, scripts/run-pr-tests.sh, " +
      "scripts/lib/verify-tree.sh, scripts/docs-coverage.sh",
  },
  {
    name: "next_role_request",
    description:
      "An AGENT_OUTPUT envelope field — not a callable tool — naming the role(s) the orchestrator " +
      "should start next. Typed as `NextRoleRequestField` (src/next-role-request.ts): " +
      "`{ roles: string[], reason: string, context: string } | null`. `roles` is always an " +
      "array, even for a single role, so the consensus-panel fan-out (H15) and an ordinary " +
      "single-role request are the same shape. The orchestrator (a Workflow step, H09) reads " +
      "it after the run ends and calls its own startAgentRun() function per role; the role " +
      "itself never spawns anything directly.",
    replaces: "scripts/spawn-agent.sh (the caller side; startAgentRun() is the orchestrator-side replacement)",
  },
  {
    name: "mcp__chrome-devtools__*",
    description:
      "The chrome-devtools MCP browser toolset (navigate_page, wait_for, take_screenshot, " +
      "list_console_messages, list_network_requests, evaluate_script, list_pages, " +
      "lighthouse_audit, ...). Never Puppeteer directly — it OOMs on shared hosts and isn't " +
      "installed.",
    replaces: "none (already the hosted browser-automation tool; not an engine script)",
  },
] as const;

export function getToolEntry(name: string): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

export const TOOL_NAMES: readonly string[] = TOOL_REGISTRY.map((t) => t.name);
