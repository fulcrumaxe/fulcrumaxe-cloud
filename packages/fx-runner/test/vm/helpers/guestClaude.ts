import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EngineRefusal } from "../../../src/engines/claude/refusal.js";
import { MIN_CLAUDE_VERSION, inspectBinary, versionSupported, type ClaudeBinary } from "../../../src/engines/claude/pin.js";
import type { SpawnFn } from "../../../src/engines/claude/capture.js";
import type { AgentClient } from "./agentClient.js";

/**
 * C19's checks against the guest's `claude`, through the engine's own `inspectBinary` and the `ClaudeBinary` it hands back. The
 * engine's `storedBinarySource` also stats the path on the HOST, which cannot work for a guest path, so the verdict below repeats its
 * four refusals over the same report; `inspectBinary` (the part that asks the binary) is the engine's own code, unchanged.
 */
function spawnInGuest(agent: AgentClient): SpawnFn {
  return ((file: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    agent.exec([file, ...args], { timeoutS: 60 }).then(
      (r) => {
        child.stdout.emit("data", Buffer.from(r.stdout));
        child.stderr.emit("data", Buffer.from(r.stderr));
        child.emit("close", r.exit);
      },
      () => child.emit("error", new Error("guest exec failed")),
    );
    return child;
  }) as unknown as SpawnFn;
}

export async function guestClaudeBinary(agent: AgentClient, storedPath = "/opt/fx/bin/claude"): Promise<ClaudeBinary> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "fx-vm-claude-"));
  try {
    const report = await inspectBinary({ storedPath, cacheDir, spawn: spawnInGuest(agent), timeoutMs: 60_000 }, {});
    if (report.version === undefined) throw new EngineRefusal("claude_version_unsupported", "the binary's version could not be read");
    if (!versionSupported(report.version)) throw new EngineRefusal("claude_version_unsupported", `version ${report.version} is older than ${MIN_CLAUDE_VERSION}`);
    if (report.missingFlags === undefined) throw new EngineRefusal("claude_flags_unsupported", "the binary's --help could not be read");
    if (report.missingFlags.length > 0) throw new EngineRefusal("claude_flags_unsupported", `lacks ${report.missingFlags.join(", ")}`);
    return { path: storedPath, version: report.version };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
