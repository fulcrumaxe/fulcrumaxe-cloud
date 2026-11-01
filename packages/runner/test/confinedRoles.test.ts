import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFINED_READ_ROLES, DISCOVERY_ANALYST_ROLE, PLATFORM_ROLES, PROPOSAL_VERIFIER_ROLE, VERIFIER_DENY, VERIFIER_READ_GUARD, agentSettingsFor, runnerToolsForRole, toolsForRole } from "../src/agentConfig.js";

/**
 * D#483 S4-f1 (R-C25-4, S4f-5 first half): the discovery analyst is a confined read-only platform role, built on the verifier's confinement.
 * Every site that means "a confined read-only platform role" tests membership of CONFINED_READ_ROLES; a comparison with the verifier's name
 * alone must say why in a `verifier-only:` comment.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const WRITE_OR_REACH = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "LS", "Task", "TodoWrite"];

describe("S4f-5: the analyst's tools are exactly the confined Read, Glob and Grep", () => {
  it("the built tool list is the verifier's, and holds no write, edit, shell, network or web tool", () => {
    const tools = toolsForRole(DISCOVERY_ANALYST_ROLE);
    expect([...tools]).toEqual(["Read(//vercel/sandbox/repo/**)", "Glob", "Grep"]);
    expect(tools).toBe(toolsForRole(PROPOSAL_VERIFIER_ROLE));
    for (const t of WRITE_OR_REACH) expect(tools.some((x) => x === t || x.startsWith(`${t}(`)), t).toBe(false);
  });

  it("the resolved settings are the verifier's: the same allow list, deny rules and read-guard hook, dontAsk", () => {
    const settings = agentSettingsFor(DISCOVERY_ANALYST_ROLE) as { permissions: { allow: string[]; deny: string[]; defaultMode: string }; hooks: { PreToolUse: unknown[] } };
    expect(settings).toEqual(agentSettingsFor(PROPOSAL_VERIFIER_ROLE));
    expect(settings.permissions.allow).toEqual(["Read(//vercel/sandbox/repo/**)", "Glob", "Grep"]);
    expect(settings.permissions.deny).toEqual([...VERIFIER_DENY]);
    expect(settings.permissions.defaultMode).toBe("dontAsk");
    expect(settings.hooks.PreToolUse).toEqual([VERIFIER_READ_GUARD]);
    for (const t of WRITE_OR_REACH) expect(settings.permissions.allow.some((x) => x === t || x.startsWith(`${t}(`)), t).toBe(false);
  });

  it("exactly the two platform roles are confined, and a role outside the set is not", () => {
    expect([...CONFINED_READ_ROLES].sort()).toEqual(["discovery-analyst", "proposal-verifier"]);
    expect([...CONFINED_READ_ROLES].sort()).toEqual([...PLATFORM_ROLES].sort());
    for (const role of ["executor", "code-reviewer", "researcher", "", "__proto__", "Discovery-Analyst"]) expect(CONFINED_READ_ROLES.has(role), role).toBe(false);
  });

  it("the runner job's tool list stays the verifier's alone: the analyst has no runner half until S4-f4", () => {
    expect([...runnerToolsForRole(PROPOSAL_VERIFIER_ROLE)]).toEqual(["Read", "Glob", "Grep"]);
    expect(runnerToolsForRole(DISCOVERY_ANALYST_ROLE)).toBe(toolsForRole(DISCOVERY_ANALYST_ROLE));
  });
});

describe("R-C25-4: no new `PROPOSAL_VERIFIER_ROLE` comparison in packages/runner/src without a reason", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : f.endsWith(".ts") ? [path.join(dir, f)] : []));
  /** A line that compares a role with the verifier's constant (===, !==, or a switch case) with no `verifier-only:` comment on it or the line above. */
  const unexplained = (text: string): number[] => {
    const lines = text.split("\n");
    return lines.flatMap((l, i) => (/(===|!==|==|!=|case)\s*PROPOSAL_VERIFIER_ROLE\b|\bPROPOSAL_VERIFIER_ROLE\s*(===|!==|==|!=)/.test(l) && !/verifier-only:/.test(`${lines[i - 1] ?? ""}\n${l}`) ? [i + 1] : []));
  };

  it("every comparison in the runner's source carries a verifier-only reason, and none is left in the confinement code paths", () => {
    const found = files(SRC).flatMap((f) => unexplained(readFileSync(f, "utf8")).map((n) => `${path.relative(SRC, f)}:${n}`));
    expect(found).toEqual([]);
  });

  it("the check does catch an unexplained comparison, and accepts an explained one", () => {
    expect(unexplained("if (role === PROPOSAL_VERIFIER_ROLE) return x;")).toEqual([1]);
    expect(unexplained("if (PROPOSAL_VERIFIER_ROLE !== role) return x;")).toEqual([1]);
    expect(unexplained("switch (r) {\n case PROPOSAL_VERIFIER_ROLE: break;\n}")).toEqual([2]);
    expect(unexplained("// verifier-only: it cites lines\nif (role === PROPOSAL_VERIFIER_ROLE) return x;")).toEqual([]);
    expect(unexplained("if (CONFINED_READ_ROLES.has(role)) return x;")).toEqual([]);
  });
});
