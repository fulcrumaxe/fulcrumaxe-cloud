import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_FLOOR, MODEL_HOST, SandboxGrantRefused, assertEnabledSandbox, assertPlainHost, sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { PACKAGE_DIR, srcFiles } from "./helpers/srcFiles.js";

const HOME = "/home/jane";
const STATE = "/home/jane/.fx-runner";
const BIN = "/home/jane/.local/bin";
const base = { workspace: "/home/jane/work/run-1", tempDir: "/tmp/fx-run-1", home: HOME, stateDir: STATE, binaryDir: BIN, workspaceRoot: "/home/jane/work", tempRoot: "/tmp" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const block = (over: Partial<Parameters<typeof sandboxSettings>[0]> = {}) => sandboxSettings({ ...base, ...over }) as Record<string, any>;

describe("sandboxSettings: the shell sandbox a job runs under", () => {
  it("is on, and fails the job rather than run unconfined", () => {
    expect(block()).toMatchObject({ enabled: true, failIfUnavailable: true });
  });

  it("has no unsandboxed fallback of any kind", () => {
    const s = block();
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect(s.excludedCommands).toEqual([]);
    expect(s.enableWeakerNestedSandbox).toBe(false);
    expect(s.enableWeakerNetworkIsolation).toBe(false);
    expect(s.filesystem.disabled).toBe(false);
  });

  it("writes only in the workspace and the temp directory, and never in the runner's state or the agent binary's directory", () => {
    const s = block();
    expect(s.filesystem.allowWrite).toEqual([base.workspace, base.tempDir]);
    expect(s.filesystem.denyWrite).toEqual([STATE, BIN]);
  });

  it("denies reads of the home directory, and re-allows only the workspace and temp directory", () => {
    const s = block();
    expect(s.filesystem.denyRead).toEqual([HOME, STATE, BIN]);
    expect(s.filesystem.allowRead).toEqual([base.workspace, base.tempDir]);
  });

  it("denies every credential location in the floor list, as paths under the home directory", () => {
    const denied = block().credentials.files;
    expect(denied.map((f: { path: string }) => f.path)).toEqual(CREDENTIAL_FLOOR.map((entry) => path.join(HOME, entry)));
    expect(denied.every((f: { mode: string }) => f.mode === "deny")).toBe(true);
    for (const must of [".ssh", ".aws", ".config/gh", ".kube", ".docker", ".gnupg", ".netrc", ".npmrc", ".claude", ".config/fx-runner"]) expect(CREDENTIAL_FLOOR).toContain(must);
  });

  it("allows exactly the model host plus the declared registries, strictly, with no local binding", () => {
    expect(block().network).toEqual({ allowedDomains: [MODEL_HOST], strictAllowlist: true, allowLocalBinding: false });
    expect(block({ registries: ["registry.npmjs.org"] }).network.allowedDomains).toEqual([MODEL_HOST, "registry.npmjs.org"]);
    expect(block({ registries: [MODEL_HOST, "registry.npmjs.org", "registry.npmjs.org"] }).network.allowedDomains).toEqual([MODEL_HOST, "registry.npmjs.org"]);
  });

  it("carries a later per-job extra read path, write path and domain, and nothing else changes", () => {
    const s = block({ extraRoots: ["/opt", "/home/jane/stores"], extraReadPaths: ["/opt/cache"], extraWritePaths: ["/home/jane/stores/repo-1"], extraDomains: ["fonts.example.com"] });
    expect(s.filesystem.allowRead).toEqual([base.workspace, base.tempDir, "/opt/cache"]);
    expect(s.filesystem.allowWrite).toEqual([base.workspace, base.tempDir, "/home/jane/stores/repo-1"]);
    expect(s.network.allowedDomains).toEqual([MODEL_HOST, "fonts.example.com"]);
    expect({ ...s, filesystem: 0, network: 0 }).toEqual({ ...block(), filesystem: 0, network: 0 });
  });

  it.each(["*.example.com", "10.0.0.1", "169.254.169.254", "[::1]", "localhost", "internal", "host:443", "a b.example.com", "", "-x.example.com", "example.com/"])("refuses the domain %j", (host) => {
    expect(() => assertPlainHost(host)).toThrow();
    expect(() => block({ extraDomains: [host] })).toThrow();
  });

  it.each([
    ["the home directory", { extraWritePaths: [HOME] }],
    ["the root", { extraReadPaths: ["/"] }],
    ["/etc", { extraReadPaths: ["/etc"] }],
    ["a credential directory", { extraReadPaths: ["/home/jane/.ssh"] }],
    ["a path inside one", { extraWritePaths: ["/home/jane/.aws/cache"] }],
    ["a parent of one", { extraReadPaths: ["/home/jane/.config"] }],
    ["the runner's state directory", { extraWritePaths: [STATE] }],
    ["a path inside it", { extraWritePaths: [`${STATE}/keys`] }],
    ["the agent binary's directory", { extraWritePaths: [BIN] }],
    ["a socket", { extraWritePaths: ["/var/run/docker.sock"] }],
    ["a relative path", { extraReadPaths: ["cache"] }],
    ["a path with ..", { extraReadPaths: ["/opt/../etc"] }],
  ])("refuses an extra path that is %s", (_label, extra) => {
    expect(() => block(extra)).toThrow(TypeError);
  });

  it("refuses a workspace or temp directory that is, or sits in, a place it must never be", () => {
    expect(() => block({ workspace: HOME })).toThrow();
    expect(() => block({ workspace: "/home/jane/.claude/ws" })).toThrow();
    expect(() => block({ workspace: `${STATE}/workspaces/run-1` })).toThrow();
    expect(() => block({ tempDir: `${BIN}/tmp` })).toThrow();
    expect(() => block({ tempDir: "/home/jane/.ssh" })).toThrow();
    expect(() => block({ workspace: "ws" })).toThrow();
    expect(() => block({ home: "home" })).toThrow();
    expect(() => block({ stateDir: ".fx-runner" })).toThrow();
  });

  it("is plain JSON, and the same input gives the same bytes", () => {
    expect(JSON.stringify(block())).toBe(JSON.stringify(block()));
    expect(JSON.parse(JSON.stringify(block()))).toEqual(block());
  });
});

describe("only an enabled block goes to the engine", () => {
  it("what sandboxSettings builds passes the guard, and an empty, disabled or loosened block does not", () => {
    expect(() => assertEnabledSandbox(block())).not.toThrow();
    for (const bad of [undefined, null, {}, { enabled: false }, { ...block(), enabled: false }, { ...block(), failIfUnavailable: false }, { ...block(), allowUnsandboxedCommands: true }, { ...block(), allowUnsandboxedCommands: undefined }]) {
      expect(() => assertEnabledSandbox(bad)).toThrow(TypeError);
    }
  });
});

describe("one builder", () => {
  it("only sandboxSettings.ts names the keys that open the sandbox, and the engine takes the block as an input", () => {
    const owners = (pattern: RegExp): string[] => srcFiles().filter(([, text]) => pattern.test(text)).map(([name]) => name);
    expect(owners(/strictAllowlist|failIfUnavailable/)).toEqual([path.join("src", "sandbox", "sandboxSettings.ts")]);
    // The engine refuses an open block through assertEnabledSandbox; it names no escape key itself.
    expect(owners(/allowUnsandboxedCommands/)).toEqual([path.join("src", "sandbox", "sandboxSettings.ts")]);
    expect(readFileSync(path.join(PACKAGE_DIR, "src", "engines", "claude", "engine.ts"), "utf8")).not.toMatch(/allowUnsandboxedCommands\s*:/);
    expect(readFileSync(path.join(PACKAGE_DIR, "src", "engines", "claude", "settingsFile.ts"), "utf8")).toContain("sandbox: Record<string, unknown>");
  });
});

describe("the credential floor is checked by path segment", () => {
  it("refuses a grant that is a child of a floor directory even when the child's name starts with two dots", () => {
    for (const grant of [`${HOME}/.ssh/..cache`, `${HOME}/.ssh/..`, `${HOME}/.config/gh/..hosts`, `${HOME}/.ssh/sub/x`]) {
      expect(() => block({ workspace: grant })).toThrow(SandboxGrantRefused);
    }
  });

  it("still grants a sibling whose name only begins like a floor directory", () => {
    expect(() => block({ workspace: `${HOME}/.sshx/ws`, workspaceRoot: HOME })).not.toThrow();
    expect(() => block({ workspace: `${HOME}/..cache/ws`, workspaceRoot: HOME })).not.toThrow();
  });
});

describe("a refused grant carries a closed code", () => {
  it("a workspace under the state directory, the home directory or a floor path is a coded refusal", () => {
    for (const over of [{ workspace: `${STATE}/workspaces/run-1` }, { workspace: HOME }, { tempDir: `${HOME}/.aws/t` }, { workspace: "ws" }]) {
      let caught: unknown;
      try {
        block(over);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SandboxGrantRefused);
      expect((caught as { code: string }).code).toBe("sandbox_grant_refused");
    }
  });
});
