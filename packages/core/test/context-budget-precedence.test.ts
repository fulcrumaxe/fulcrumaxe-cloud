import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTEXT_BUDGET_MAX_BYTES, CONTEXT_BUDGET_MIN_BYTES, CONTEXT_BUDGET_ROLES, ROLE_CONTEXT_DEFAULTS, itemBudgetMax, readBudgetLevels, resolveContextBudget, roleBudgetMax } from "../src/context/contextBudget.js";

/** D#600 CX-12: the one precedence (item, role, repository, role default) and the bounds the writes use. */
describe("resolveContextBudget", () => {
  const none = { item: null, role: null, repo: null };

  it("takes the item, then the role, then the repository, then the role's default, and names the level", () => {
    const all = { item: 6000, role: 7000, repo: 8000 };
    expect(resolveContextBudget("executor", all)).toEqual({ bytes: 6000, source: "item" });
    expect(resolveContextBudget("executor", { ...all, item: null })).toEqual({ bytes: 7000, source: "role" });
    expect(resolveContextBudget("executor", { ...all, item: null, role: null })).toEqual({ bytes: 8000, source: "repo" });
    expect(resolveContextBudget("executor", none)).toEqual({ bytes: ROLE_CONTEXT_DEFAULTS.executor, source: "default" });
  });

  it("holds an item or role value to the running role's default times 2 (the smaller applies); the repository keeps its own range", () => {
    for (const role of CONTEXT_BUDGET_ROLES) {
      const cap = ROLE_CONTEXT_DEFAULTS[role] * 2;
      expect(roleBudgetMax(role)).toBe(cap);
      expect(resolveContextBudget(role, { ...none, item: cap + 1000 })).toEqual({ bytes: cap, source: "item" });
      expect(resolveContextBudget(role, { ...none, role: cap + 1000 })).toEqual({ bytes: cap, source: "role" });
      expect(resolveContextBudget(role, { ...none, item: CONTEXT_BUDGET_MIN_BYTES })).toEqual({ bytes: CONTEXT_BUDGET_MIN_BYTES, source: "item" });
      expect(resolveContextBudget(role, { ...none, repo: CONTEXT_BUDGET_MAX_BYTES })).toEqual({ bytes: CONTEXT_BUDGET_MAX_BYTES, source: "repo" });
    }
    expect(itemBudgetMax()).toBe(Math.max(...CONTEXT_BUDGET_ROLES.map(roleBudgetMax)));
  });

  it("an item value that is the largest role's bound still cannot lift a smaller role past its own limit", () => {
    expect(resolveContextBudget("code-reviewer", { ...none, item: itemBudgetMax() }).bytes).toBe(ROLE_CONTEXT_DEFAULTS["code-reviewer"] * 2);
    expect(resolveContextBudget("fix", { ...none, item: itemBudgetMax() }).bytes).toBe(itemBudgetMax());
  });

  it("a level that is not a stored in-range integer is skipped, so no NaN or undefined reaches a caller", () => {
    const bad = [0, 4095, 2_097_153, 1.5, Number.NaN];
    for (const v of bad) expect(resolveContextBudget("executor", { item: v, role: v, repo: v }), String(v)).toEqual({ bytes: ROLE_CONTEXT_DEFAULTS.executor, source: "default" });
    expect(resolveContextBudget("executor", { item: 4095, role: 7000, repo: 8000 })).toEqual({ bytes: 7000, source: "role" });
  });

  it("mutation guard: dropping any level from the precedence turns one of the checks above red (each level is the answer for some input)", () => {
    const answers = new Set([
      resolveContextBudget("executor", { item: 6000, role: 7000, repo: 8000 }).source,
      resolveContextBudget("executor", { item: null, role: 7000, repo: 8000 }).source,
      resolveContextBudget("executor", { item: null, role: null, repo: 8000 }).source,
      resolveContextBudget("executor", none).source,
    ]);
    expect([...answers].sort()).toEqual(["default", "item", "repo", "role"]);
  });

  it("every consumer goes through the one function: none of the call sites keeps the old two-level read", () => {
    const root = new URL("../../", import.meta.url);
    for (const file of ["pipeline/src/advance/build.ts", "runner/src/targets/jobIssuer.ts", "pipeline/src/prompt/contextRulesSave.ts", "pipeline/src/prompt/contextRulesRemove.ts", "pipeline/src/prompt/contextBudgetSetting.ts"]) {
      const text = readFileSync(new URL(file, root), "utf8");
      expect(text, file).not.toMatch(/effectiveContextBudget\(\s*(deps\.budgetRole|"executor")/);
      expect(text, file).not.toMatch(/readContextBudgetBytes/);
    }
  });
});

describe("readBudgetLevels", () => {
  it("reads the three levels in one query and treats a role not on the closed list as unset", async () => {
    const seen: Array<{ sql: string; values: unknown[] }> = [];
    const client = { query: async (sql: string, values: unknown[]) => (seen.push({ sql, values }), { rows: [{ repo: "9000", role: "7000", item: null }] }) };
    expect(await readBudgetLevels(client, "acct", "repo", "item", "fix")).toEqual({ repo: 9000, role: 7000, item: null });
    expect(await readBudgetLevels(client, "acct", "repo", null, "planner" as never)).toEqual({ repo: 9000, role: null, item: null });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.values).toEqual(["acct", "repo", "fix", "item"]);
  });
});
