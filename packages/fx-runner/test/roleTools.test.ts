import { RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
import { roleToolsDigest as cloudDigest, toolsForRole } from "@fx/runner";
import { describe, expect, it } from "vitest";
import { ROLE_TOOLS, UnknownRoleError, roleToolsDigest, roleToolsFor } from "../src/job/roleTools.js";

const banned = (tool: string): boolean => tool === "WebFetch" || tool === "WebSearch" || tool.startsWith("mcp__");

describe("role table", () => {
  it("has exactly the runner-eligible roles as keys", () => {
    expect(Object.keys(ROLE_TOOLS).sort()).toEqual([...RUNNER_ELIGIBLE_ROLES].sort());
  });

  it("each entry deep-equals the cloud's list for the role minus the banned names", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) {
      expect(roleToolsFor(role), role).toEqual(toolsForRole(role).filter((tool) => !banned(tool)));
    }
  });

  it("the cloud's lists for these roles hold no banned name at all, so the derivation removes nothing today", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) expect(toolsForRole(role).filter(banned), role).toEqual([]);
  });

  it("no entry holds web fetch, web search or an MCP tool, and entries are non-empty and frozen", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) {
      const entry = roleToolsFor(role);
      expect(entry.length, role).toBeGreaterThan(0);
      expect(entry.filter(banned), role).toEqual([]);
      expect(Object.isFrozen(entry), role).toBe(true);
    }
    expect(Object.isFrozen(ROLE_TOOLS)).toBe(true);
  });

  it("only the executor has an edit or write tool", () => {
    const editing = (role: string) => roleToolsFor(role).filter((tool) => ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool));
    expect(editing("executor").length).toBe(4);
    for (const role of RUNNER_ELIGIBLE_ROLES.filter((r) => r !== "executor")) expect(editing(role), role).toEqual([]);
  });
});

describe("role tools digest", () => {
  it("equals the cloud's digest for every eligible role", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) expect(roleToolsDigest(role), role).toBe(cloudDigest(role));
  });

  it("is a SHA-256 that differs between a role that edits and one that does not", () => {
    expect(roleToolsDigest("executor")).toMatch(/^[0-9a-f]{64}$/);
    expect(roleToolsDigest("executor")).not.toBe(roleToolsDigest("code-reviewer"));
  });
});

describe("unknown role fails closed", () => {
  it("throws, where the cloud's own lookup falls back to a look-only list", () => {
    expect(toolsForRole("not-a-role").length).toBeGreaterThan(0);
    for (const role of ["not-a-role", "", "Executor", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => roleToolsFor(role), role).toThrow(UnknownRoleError);
      expect(() => roleToolsDigest(role), role).toThrow(UnknownRoleError);
    }
    expect(() => roleToolsFor(undefined as unknown as string)).toThrow(UnknownRoleError);
  });
});
