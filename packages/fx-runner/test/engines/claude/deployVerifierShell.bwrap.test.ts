import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import { bashSandboxArgs, bashSandboxUnusable } from "../../../src/engines/claude/bashSandboxProbe.js";
import { baseToolNames, claudeArgv } from "../../../src/engines/claude/argv.js";
import { settingsFor } from "../../../src/engines/claude/settingsFile.js";
import { roleToolsFor } from "../../../src/job/roleTools.js";
import { protectedPaths } from "../../../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "../../helpers/bwrapProbe.js";
import { tmpRoot } from "../../helpers/tmpRoot.js";

/**
 * D#749 V2b, in the style of bashSandbox.bwrap.test.ts: the deploy verifier is given no shell, and this proves it on the real settings file and the real bubblewrap.
 *  - the role's real settings and command line name no Bash tool anywhere (not in the allow rules, not in `--tools`), so the CLI has no shell call to make;
 *  - the engine's start-up probe, run under real bubblewrap with the role's own settings, does not refuse the role (it would end every run `sandbox_unusable`);
 *  - control: a shell that WERE somehow run under the role's sandbox block still cannot write outside the checkout (the whole filesystem is read-only but the checkout).
 * What this cannot show is the CLI's own tool list at run time (the CLI is not run in tests); the owner's smoke step in docs/packages/runner.md checks the init line for it.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);
const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };

let root: string;
let ws: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpRoot(), "dv-bwrap-"));
  ws = path.join(root, "ws");
  mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(ws, ".git", "config"), "[core]\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const settings = () => JSON.parse(JSON.stringify(settingsFor(DEPLOY_VERIFIER_ROLE, SANDBOX, ws, protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin") })))) as { permissions: { allow: string[]; deny: string[] } };

describe("the deploy verifier has no shell", () => {
  it("no allow rule and no --tools entry names Bash, and no rule allows an edit", () => {
    const tools = roleToolsFor(DEPLOY_VERIFIER_ROLE);
    expect(baseToolNames(tools)).not.toContain("Bash");
    const argv = claudeArgv({ cliModel: "sonnet", roleTools: tools, allowRules: settings().permissions.allow, settingsPath: "/s", mcpPath: "/m", chrome: true });
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(argv.some((part) => /^Bash/.test(part))).toBe(false);
    expect(settings().permissions.allow.some((rule) => /^(Bash|Edit|Write|MultiEdit|NotebookEdit)/.test(rule))).toBe(false);
  });

  describe.skipIf(!usable)("under real bubblewrap", () => {
    it("the engine's start probe accepts the role's own settings", async () => {
      const run = async (file: string, args: readonly string[]) => {
        const r = spawnSync(file, [...args], { encoding: "utf8", timeout: 20_000 });
        return { code: r.status, stderr: r.stderr };
      };
      expect(await bashSandboxUnusable(settings(), ws, { PATH: process.env["PATH"] ?? "" }, path.join(root, "scratch"), run)).toBe(false);
    });

    it("control: even a shell run under the role's sandbox block writes nothing outside the checkout", () => {
      const outside = path.join(root, "outside.txt");
      const under = (command: string) => spawnSync(BWRAP as string, [...bashSandboxArgs(settings(), ws, ws), "--chdir", ws, "--", "sh", "-c", command], { encoding: "utf8", timeout: 20_000 });
      expect(under(`echo x > ${outside}`).status).not.toBe(0);
      expect(existsSync(outside)).toBe(false);
      expect(under("echo y > inside.txt").status).toBe(0);
    });
  });
});
