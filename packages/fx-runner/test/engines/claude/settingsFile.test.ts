import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EngineRefusal } from "../../../src/engines/claude/refusal.js";
import { mcpConfigFor, settingsFor, writeJobFiles } from "../../../src/engines/claude/settingsFile.js";
import { roleToolsFor } from "../../../src/job/roleTools.js";
import { protectedPaths } from "../../../src/sandbox/sandboxSettings.js";
import { confineFileTools, denyRules } from "../../../src/engines/claude/filePermissions.js";
import { makeWorkspace } from "./harness.js";

const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };
const WS = "/home/jane/work/run-1";
const PROTECTED = protectedPaths({ home: "/home/jane", stateDir: "/home/jane/.fx-runner", binaryDir: "/home/jane/.local/bin" });

describe("settings and MCP files", () => {
  it("the settings file holds exactly hooks off, dontAsk, the confined role entry, the deny floor, reads fenced to the working directory and the sandbox block", () => {
    const file = settingsFor("code-reviewer", SANDBOX, WS, PROTECTED);
    expect(file).toEqual({
      disableAllHooks: true,
      permissions: { defaultMode: "dontAsk", allow: confineFileTools(roleToolsFor("code-reviewer"), WS), deny: denyRules(PROTECTED), blockReadsOutsideWorkingDirectories: true },
      sandbox: SANDBOX,
    });
    const permissions = (file as { permissions: Record<string, unknown> }).permissions;
    expect(permissions.deny).not.toEqual([]);
    expect(permissions).not.toHaveProperty("additionalDirectories");
    // Same workspace, same bytes: a resume gets the file a fresh run got.
    expect(JSON.stringify(settingsFor("code-reviewer", SANDBOX, WS, PROTECTED))).toBe(JSON.stringify(file));
    for (const key of ["env", "apiKeyHelper", "hooks", "model", "statusLine"]) expect(settingsFor("executor", SANDBOX, WS, PROTECTED)).not.toHaveProperty(key);
  });

  it("an unknown role throws rather than getting a default list", () => {
    expect(() => settingsFor("not-a-role", SANDBOX, WS, PROTECTED)).toThrow();
  });

  it("the MCP file is the empty server map, from the one function", () => {
    expect(mcpConfigFor({ role: "executor" })).toEqual({ mcpServers: {} });
  });

  it("files are 0600 in a 0700 directory, outside the workspace", () => {
    const rig = makeWorkspace();
    const jobDir = path.join(rig.root, "jobs", "run-x");
    const { settingsPath, mcpPath } = writeJobFiles(jobDir, rig.workdir, "executor", SANDBOX, PROTECTED);
    expect(statSync(jobDir).mode & 0o777).toBe(0o700);
    for (const file of [settingsPath, mcpPath]) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toEqual({ mcpServers: {} });
  });

  it("refuses a job directory inside the workspace, or the workspace itself", () => {
    const rig = makeWorkspace();
    for (const dir of [path.join(rig.workdir, ".fx"), rig.workdir]) {
      expect(() => writeJobFiles(dir, rig.workdir, "executor", SANDBOX, PROTECTED)).toThrow(EngineRefusal);
    }
  });
});
