/**
 * The role manifest: one entry per ported card in `cards/*.md`.
 *
 * This is the data the orchestrator reads before every spawn — which model
 * to use, what mode the tenant has this role set to, the per-spawn spend
 * cap, and whether the role needs a browser. It does not contain prompt
 * text; the prompt text lives in the matching `cards/<name>.md` file.
 */

export type RoleMode = "off" | "weekly" | "feature_critical" | "always";

export interface RoleManifestEntry {
  /** Matches the card's filename (cards/<name>.md) and its frontmatter `name`. */
  name: string;
  /** Short, human-readable description of what starts this role. */
  trigger: string;
  /** The mode a newly-installed repo starts with, before any tenant override. */
  defaultMode: RoleMode;
  /** Modes this role can legally be set to. Always includes "off". */
  allowedModes: RoleMode[];
  /** The model alias used when the tenant hasn't overridden it (see H22 routing). */
  defaultModel: "haiku" | "sonnet" | "opus";
  /** Refused above this per-run spend (packages/spend enforces it; this is the manifest default). */
  perSpawnCapUsd: number;
  /** True only for the three roles that drive a real browser (H20). */
  needsBrowser: boolean;
  /** True only for roles that push commits to the repo. Every other role is read-only
   *  plus GitHub metadata writes (comments/labels), matching the H03 proxy policy. */
  writeAccess: boolean;
}

export const ROLE_MANIFEST: readonly RoleManifestEntry[] = [
  {
    name: "executor",
    trigger: "work item reaches spec_ready, or a PR gets a needs-fix verdict",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 40,
    needsBrowser: false,
    writeAccess: true,
  },
  {
    name: "code-reviewer",
    trigger: "PR opened or updated",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "security-reviewer",
    trigger: "PR opened or updated, when the security trigger fires or the tier requires it",
    defaultMode: "always",
    allowedModes: ["off", "feature_critical", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 40,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "acceptance-tester",
    trigger: "PR opened or updated",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "debater",
    trigger: "code-reviewer or security-reviewer returns pass, on Feature/Critical work",
    // D#483 P3 owner ruling: OFF until the repo's owner turns it on.
    defaultMode: "off",
    allowedModes: ["off", "feature_critical", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "project-manager",
    trigger: "new Discussion/Issue intake, or an executor/reviewer run completes",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 40,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "technical-architect",
    trigger: "consensus panel request from project-manager",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "product-owner",
    trigger: "consensus panel request from project-manager",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "cost-analyst",
    trigger: "consensus panel request from project-manager",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "performance-expert",
    trigger: "consensus panel request from project-manager",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "security-expert",
    trigger: "consensus panel request from project-manager",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "researcher",
    trigger: "consensus panel request when the topic matches external-dependency keywords",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "feedback-scanner",
    trigger: "new Issue, Discussion, or PR-review-comment webhook event",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "incident-commander",
    trigger: "circuit-breaker trip or health-stall event",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "browser-tester",
    trigger: "PR touches a UI surface and code-reviewer already passed",
    defaultMode: "always",
    allowedModes: ["off", "feature_critical", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: true,
    writeAccess: false,
  },
  {
    name: "tui-tester",
    trigger: "PR touches a UI surface, on a repo flagged as having a TUI",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: true,
    writeAccess: false,
  },
  {
    name: "docs-writer",
    trigger: "PR opened or updated, alongside code-reviewer",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: true,
  },
  {
    name: "release-manager",
    trigger: "merge event",
    defaultMode: "always",
    allowedModes: ["off", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "runbook-writer",
    trigger: "release-manager classifies a merged PR as high risk",
    defaultMode: "feature_critical",
    allowedModes: ["off", "feature_critical", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: true,
  },
  {
    name: "accessibility-reviewer",
    trigger: "PR touches a UI surface",
    defaultMode: "feature_critical",
    allowedModes: ["off", "feature_critical", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "ux-designer",
    trigger: "a UI Discussion needs a design note before the Spec is written",
    defaultMode: "feature_critical",
    allowedModes: ["off", "feature_critical", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: true,
  },
  {
    name: "mission-analyst",
    trigger: "scheduled weekly, or a mission review / idea-validation request",
    defaultMode: "weekly",
    allowedModes: ["off", "weekly", "always"],
    defaultModel: "opus",
    perSpawnCapUsd: 40,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "run-analyst",
    trigger: "scheduled weekly, or on demand",
    defaultMode: "weekly",
    allowedModes: ["off", "weekly", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "analytics-engineer",
    trigger: "scheduled weekly, or on demand",
    defaultMode: "weekly",
    allowedModes: ["off", "weekly", "always"],
    defaultModel: "sonnet",
    perSpawnCapUsd: 15,
    needsBrowser: false,
    writeAccess: false,
  },
  {
    name: "visual-verifier",
    trigger: "scheduled weekly",
    defaultMode: "weekly",
    allowedModes: ["off", "weekly", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: true,
    writeAccess: false,
  },
  {
    name: "quality-sweep",
    trigger: "project-manager's queue is empty, or a periodic checkpoint",
    defaultMode: "off",
    allowedModes: ["off", "weekly", "always"],
    defaultModel: "haiku",
    perSpawnCapUsd: 5,
    needsBrowser: false,
    writeAccess: false,
  },
] as const;

export function getRoleEntry(name: string): RoleManifestEntry | undefined {
  return ROLE_MANIFEST.find((r) => r.name === name);
}

export const ROLE_NAMES: readonly string[] = ROLE_MANIFEST.map((r) => r.name);
