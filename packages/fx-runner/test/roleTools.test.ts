import { CHROME_TOOL_PREFIX, DEPLOY_VERIFIER_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, RUNNER_ELIGIBLE_ROLES, isMcpToolName } from "@fulcrumaxe/runner-protocol";
import { roleToolsDigest as cloudDigest, runnerToolsForRole as toolsForRole } from "@fx/runner";
import { describe, expect, it } from "vitest";
import { ROLE_TOOLS, UnknownRoleError, roleToolsDigest, roleToolsFor } from "../src/job/roleTools.js";

// D#749 V2b: the one MCP tools a runner grants are the deploy verifier's browser tools; for every other role an MCP tool is as banned as before.
const banned = (tool: string, role?: string): boolean => tool === "WebFetch" || tool === "WebSearch" || (isMcpToolName(tool) && !(role === DEPLOY_VERIFIER_ROLE && DEPLOY_VERIFIER_BROWSER_TOOLS.includes(tool)));

describe("role table", () => {
  it("has exactly the runner-eligible roles as keys", () => {
    expect(Object.keys(ROLE_TOOLS).sort()).toEqual([...RUNNER_ELIGIBLE_ROLES].sort());
  });

  // D#483 S4-b2c: the cloud's list for a runner job (`runnerToolsForRole`): `toolsForRole` for every role but the claim verifier, whose sandbox list names
  // the sandbox's own checkout; its runner job is signed with the bare three instead.
  it("each entry deep-equals the cloud's list for the role minus the banned names", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) {
      expect(roleToolsFor(role), role).toEqual(toolsForRole(role).filter((tool) => !banned(tool, role)));
    }
  });

  it("the cloud's lists for these roles hold no banned name at all, so the derivation removes nothing today", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) expect(toolsForRole(role).filter((tool) => banned(tool, role)), role).toEqual([]);
  });

  it("no entry holds web fetch, web search or an MCP tool, and entries are non-empty and frozen", () => {
    for (const role of RUNNER_ELIGIBLE_ROLES) {
      const entry = roleToolsFor(role);
      expect(entry.length, role).toBeGreaterThan(0);
      expect(entry.filter((tool) => banned(tool, role)), role).toEqual([]);
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
  it("throws, as the cloud's own lookup does", () => {
    expect(() => toolsForRole("not-a-role")).toThrow(/no tool list/);
    for (const role of ["not-a-role", "", "Executor", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => roleToolsFor(role), role).toThrow(UnknownRoleError);
      expect(() => roleToolsDigest(role), role).toThrow(UnknownRoleError);
    }
    expect(() => roleToolsFor(undefined as unknown as string)).toThrow(UnknownRoleError);
  });
});

// D#749 V2b (V5 card review): the exact browser list is pinned here, so adding javascript_tool, file_upload, upload_image or form_input to it turns this red.
describe("the deploy verifier's exact tool list", () => {
  it("is the three read tools and exactly these nine browser tools, in this order", () => {
    expect([...roleToolsFor(DEPLOY_VERIFIER_ROLE)]).toEqual([
      "Read", "Glob", "Grep",
      ...["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "computer", "find", "read_page", "get_page_text", "read_console_messages"].map((tool) => `${CHROME_TOOL_PREFIX}${tool}`),
    ]);
  });

  it("the Playwright verifier runs without the three read tools while its digest still covers the signed list", () => {
    expect(roleToolsDigest(DEPLOY_VERIFIER_ROLE, "playwright_runner")).toBe(cloudDigest(DEPLOY_VERIFIER_ROLE, "playwright_runner"));
    const run = roleToolsFor(DEPLOY_VERIFIER_ROLE, "playwright_runner");
    for (const tool of ["Read", "Glob", "Grep"]) expect(run, tool).not.toContain(tool);
    expect(run.length).toBeGreaterThan(0);
    expect(roleToolsFor(DEPLOY_VERIFIER_ROLE, "chrome_runner")).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
  });

  it("holds none of the five extension tools that run script, read request headers, upload a file or fill a form", () => {
    const entry = roleToolsFor(DEPLOY_VERIFIER_ROLE).join(" ");
    for (const never of ["javascript_tool", "file_upload", "upload_image", "form_input", "read_network_requests"]) expect(entry, never).not.toContain(never);
  });
});
