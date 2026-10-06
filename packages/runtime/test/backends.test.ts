import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeCodeBackend } from "../src/backends/claudeCode.js";
import { BackendNotSelectableError, PIN_CHECK_NAME, PIN_CHECK_SCRIPT, PIN_EXIT_DIGEST, PIN_EXIT_OTHER, createBackendRegistry, verifyPin } from "../src/backends/registry.js";
import type { AgentBackend } from "../src/backends/types.js";

const SHA = "a".repeat(64);
const claude = (over: Partial<Parameters<typeof createClaudeCodeBackend>[0]> = {}) =>
  createClaudeCodeBackend({ cliVersion: "2.1.287", cliSha256: SHA, settingsPath: "/fx/agent-config/settings.json", mcpPath: "/fx/agent-config/mcp.json", ...over });

describe("D#221 R1a: the Claude Code descriptor builds the command line the port built before", () => {
  it("start and resume, written out literally", () => {
    const b = claude();
    const head = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", "/fx/agent-config/settings.json", "--strict-mcp-config", "--mcp-config", "/fx/agent-config/mcp.json"];
    expect(b.buildArgv({ cliModel: "claude-sonnet-5", maxTurns: 17, capUsd: 5 })).toEqual([...head, "--max-turns", "17", "--max-budget-usd", "5", "--model", "claude-sonnet-5"]);
    expect(b.buildArgv({ cliModel: "claude-sonnet-5", maxTurns: 17, capUsd: 5, resumeSessionId: "sess-9" }).slice(-2)).toEqual(["--resume", "sess-9"]);
    expect(b.baseArgv).toEqual(head);
  });
});

describe("D#221 R1a: the registry", () => {
  it("selects a registered backend, the default when no name is given", () => {
    const r = createBackendRegistry([claude()]);
    expect(r.names()).toEqual(["claude-code"]);
    expect(r.select().name).toBe("claude-code");
    expect(r.select("claude-code").cli).toBe("claude");
  });

  it("refuses a name that is not registered, whatever its shape", () => {
    const r = createBackendRegistry([claude()]);
    for (const name of ["codex", "", "CLAUDE-CODE", "__proto__", "constructor", "claude-code "]) {
      expect(() => r.select(name), name).toThrow(BackendNotSelectableError);
    }
    expect(() => r.select(7 as unknown as string)).toThrow(BackendNotSelectableError);
  });

  it("refuses to register a backend without a hostile-config registration", () => {
    const none: AgentBackend = { ...claude(), hostileConfig: { requiredArgv: [] } };
    expect(() => createBackendRegistry([none])).toThrow(BackendNotSelectableError);
    const emptyGroup: AgentBackend = { ...claude(), hostileConfig: { requiredArgv: [[]] } };
    expect(() => createBackendRegistry([emptyGroup])).toThrow(BackendNotSelectableError);
  });

  it("refuses a backend with a bad name, CLI, version, digest, or a base argv that does not start with its CLI", () => {
    for (const bad of [
      { ...claude(), name: "Bad Name" },
      { ...claude(), cli: "../claude" },
      { ...claude(), cliVersion: "latest" },
      { ...claude(), cliSha256: "A".repeat(64) },
      { ...claude(), cliSha256: "abc" },
      { ...claude(), baseArgv: ["node"] },
    ] as AgentBackend[]) {
      expect(() => createBackendRegistry([bad])).toThrow(BackendNotSelectableError);
    }
  });

  it("refuses a backend whose registered flag groups are not in the command line it builds (start or resume)", () => {
    const real = claude();
    const claimsMore: AgentBackend = { ...real, hostileConfig: { requiredArgv: [...real.hostileConfig.requiredArgv, ["--not-a-flag"]] } };
    expect(() => createBackendRegistry([claimsMore])).toThrow(BackendNotSelectableError);
    const dropsOnResume: AgentBackend = { ...real, buildArgv: (i) => (i.resumeSessionId === undefined ? real.buildArgv(i) : ["claude", "--resume", i.resumeSessionId]) };
    expect(() => createBackendRegistry([dropsOnResume])).toThrow(BackendNotSelectableError);
  });

  it("refuses a duplicate name", () => {
    expect(() => createBackendRegistry([claude(), claude()])).toThrow(BackendNotSelectableError);
  });

  it("is frozen: no backend can be added after it is built", () => {
    const r = createBackendRegistry([claude()]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => { (r as unknown as { select: unknown }).select = () => claude(); }).toThrow();
  });
});

describe("D#221 R1a: verifyPin", () => {
  const b = claude();
  const ok = "2.1.287 (Claude Code)\n";
  it("passes the pinned version after a matching digest (exit 0)", () => expect(verifyPin(b, 0, ok)).toBe("ok"));
  it("a wrong version is cliVersion", () => expect(verifyPin(b, 0, "2.1.0\n")).toBe("cliVersion"));
  it("the digest verdict is the exit status alone: exit 4 is cliDigest whatever the output says", () => {
    expect(verifyPin(b, 4, ok)).toBe("cliDigest");
    expect(verifyPin(b, 4, `${ok}${SHA}  /forged\n`)).toBe("cliDigest");
    expect(verifyPin(b, 4, "")).toBe("cliDigest");
  });
  it("output that went past the reader's cap is a failure, never a pass", () => expect(verifyPin(b, 0, ok, true)).toBe("cliVersion"));
  it("any other exit, or no exit (a timeout), is cliVersion", () => {
    expect(verifyPin(b, 5, ok)).toBe("cliVersion");
    expect(verifyPin(b, 1, ok)).toBe("cliVersion");
    expect(verifyPin(b, undefined, ok)).toBe("cliVersion");
  });
  it("empty output is cliVersion", () => expect(verifyPin(b, 0, "")).toBe("cliVersion"));
});

describe("D#221 R1a: the pin check script, run by a real sh against real files", () => {
  const sha = (content: string) => createHash("sha256").update(content).digest("hex");
  /** A temp dir with `real` (the file) and `bin/claude` (a symlink to it); `marker` is created only if `real` is ever run. */
  function withBinary<T>(body: (d: { dir: string; real: string; bin: string; marker: string; run: (pin: string) => ReturnType<typeof spawnSync> }) => T): T {
    const dir = mkdtempSync(path.join(os.tmpdir(), "r1a221_pin-"));
    try {
      const real = path.join(dir, "real-claude");
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      return body({
        dir, real, bin, marker: path.join(dir, "ran"),
        run: (pin) => spawnSync("sh", ["-c", PIN_CHECK_SCRIPT, PIN_CHECK_NAME, "claude", pin], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const install = (real: string, bin: string, content: string) => {
    writeFileSync(real, content);
    chmodSync(real, 0o755);
    symlinkSync(real, path.join(bin, "claude"));
  };

  it("hashes the RESOLVED file and runs that resolved path (not the symlink), then reports its version", () =>
    withBinary(({ real, bin, run }) => {
      const content = '#!/bin/sh\necho "2.1.287 $0"\n';
      install(real, bin, content);
      const r = run(sha(content));
      expect(r.status).toBe(0);
      // $0 is the path the script was run as: the resolved file, because readlink -f ran before the exec.
      expect(String(r.stdout).trim()).toBe(`2.1.287 ${real}`);
      expect(verifyPin(claude({ cliSha256: sha(content) }), r.status ?? undefined, String(r.stdout))).toBe("ok");
    }));

  it("a binary that differs from the pin is never executed: exit 4, no output, no side effect", () =>
    withBinary(({ real, bin, marker, run }) => {
      const pinned = '#!/bin/sh\necho "2.1.287 genuine"\n';
      // The tampered file would print a pinned-looking hash after a huge chunk, and fork a writer that outlives it.
      const tampered = `#!/bin/sh\ntouch ${marker}\nprintf '%02000d\\n' 0\necho "${sha(pinned)}  /usr/local/bin/claude"\n( sleep 1; echo "${sha(pinned)}  /late" ) &\n`;
      install(real, bin, tampered);
      const r = run(sha(pinned));
      expect(r.status).toBe(PIN_EXIT_DIGEST);
      expect(String(r.stdout)).toBe("");
      expect(existsSync(marker), "the tampered binary ran").toBe(false);
      expect(verifyPin(claude({ cliSha256: sha(pinned) }), r.status ?? undefined, String(r.stdout))).toBe("cliDigest");
    }));

  it("a pinned-digest binary of another version fails as cliVersion", () =>
    withBinary(({ real, bin, run }) => {
      const content = '#!/bin/sh\necho "2.0.0"\n';
      install(real, bin, content);
      const r = run(sha(content));
      expect(verifyPin(claude({ cliSha256: sha(content) }), r.status ?? undefined, String(r.stdout))).toBe("cliVersion");
    }));

  it("a genuine binary whose --version itself exits 4 ends as 5 (cliVersion), never as 4 (cliDigest)", () =>
    withBinary(({ real, bin, run }) => {
      const content = '#!/bin/sh\necho "2.1.287"\nexit 4\n';
      install(real, bin, content);
      const r = run(sha(content));
      expect(r.status).toBe(PIN_EXIT_OTHER);
      expect(verifyPin(claude({ cliSha256: sha(content) }), r.status ?? undefined, String(r.stdout))).toBe("cliVersion");
    }));

  it("a missing CLI exits 5 (not 4)", () =>
    withBinary(({ bin }) => {
      const r = spawnSync("sh", ["-c", PIN_CHECK_SCRIPT, PIN_CHECK_NAME, "fx-no-such-cli", SHA], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
      expect(r.status).toBe(PIN_EXIT_OTHER);
    }));
});
