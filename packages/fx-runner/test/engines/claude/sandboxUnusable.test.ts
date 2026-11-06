import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createClaudeEngine, jobDirFor, outcomeOf } from "../../../src/engines/claude/engine.js";
import { createClaudeKit } from "../../../src/engines/claude/kit.js";
import { testLaunch } from "../../helpers/launch.js";
import { ON_BLOCK, RUN_ID, engineFor, makeRig } from "./rig.js";

/**
 * The start-up probe at the engine: when bubblewrap refuses a no-op under the job's own rules, the run ends with the closed code `sandbox_unusable`
 * before the agent is started, instead of the agent looping on Bash calls that all fail. The `bwrap` on the agent's PATH is a script here, so this holds on any host;
 * the real bubblewrap is in `bashSandbox.bwrap.test.ts`.
 */
function rigWithBwrap(script: string, realProbe = true) {
  const rig = makeRig({ realSandboxProbe: realProbe });
  const dir = path.join(rig.root, "tools");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "bwrap"), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(dir, "bwrap"), 0o755);
  // The host environment is read by name, and a directory the job adds goes after the host entries, so the script goes first on the host PATH itself.
  vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
  return rig;
}

describe("sandbox_unusable: the probe before the agent starts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a bubblewrap refusal ends the run as sandbox_unusable with no agent started and nothing left behind", async () => {
    const refused = rigWithBwrap(`echo "bwrap: Can't create file ws/.git/config.lock: Read-only file system" >&2; exit 1`);
    await expect(engineFor(refused).start(refused.startOptions())).rejects.toMatchObject({ code: "sandbox_unusable" });
    expect(existsSync(path.join(jobDirFor(refused.config.jobsDir, RUN_ID), "probe"))).toBe(false);
    expect(readdirSync(jobDirFor(refused.config.jobsDir, RUN_ID)).sort()).toEqual(["mcp.json", "settings.json"]);

    const fine = rigWithBwrap("exit 0");
    const { handle } = await engineFor(fine).start(fine.startOptions());
    await outcomeOf(handle);
    // The agent itself is one more process than the refused run started.
    expect(fine.fake.spawnCount()).toBeGreaterThan(refused.fake.spawnCount());
  });

  it("a failure that is not bubblewrap's does not stop the run", async () => {
    const other = rigWithBwrap(`echo "something else" >&2; exit 1`);
    const { handle } = await engineFor(other).start(other.startOptions());
    await outcomeOf(handle);
    expect(other.fake.spawnCount()).toBeGreaterThan(0);
  });

  it("the probe is the engine's own seam: an injected answer replaces the machine's bubblewrap, in both directions, and a true answer is the same closed refusal", async () => {
    // A bubblewrap that refuses is on the PATH. The default rig answers the probe itself, so it never reaches that tool: the run starts.
    const usable = rigWithBwrap(`echo "bwrap: No permissions to create a new namespace" >&2; exit 1`, false);
    const { handle } = await engineFor(usable).start(usable.startOptions());
    await outcomeOf(handle);
    expect(usable.fake.spawnCount()).toBeGreaterThan(0);

    // A true answer from the seam ends the run before the agent exists, with the same code and nothing left behind.
    const unusable = makeRig({});
    const seen: string[] = [];
    const engine = createClaudeEngine({ ...unusable.config, bashSandboxUnusable: async (_settings, workspace) => (seen.push(workspace), true) });
    await expect(engine.start(unusable.startOptions())).rejects.toMatchObject({ code: "sandbox_unusable" });
    expect(seen).toEqual([unusable.workdir]);
    expect(readdirSync(jobDirFor(unusable.config.jobsDir, RUN_ID)).sort()).toEqual(["mcp.json", "settings.json"]);
  });

  it("the kit hands its seam to every engine it makes, and without one the engine uses the real probe", async () => {
    const rig = makeRig({ realSandboxProbe: true });
    const input = { binaryPath: rig.fake.binary, credentials: { mode: "subscription" as const }, envOptions: {}, sandboxSettings: ON_BLOCK, protectedPaths: rig.config.protectedPaths, stateDir: path.join(rig.root, "state"), onLocalEvent: () => undefined };
    const seamed = createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: async () => true }).makeRuntime(input);
    await expect(seamed.start(rig.startOptions())).rejects.toMatchObject({ code: "sandbox_unusable" });

    // No seam: the machine's bubblewrap decides. A tool that refuses with bubblewrap's own words ends the run, so the real probe is what ran.
    const dir = path.join(rig.root, "tools");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "bwrap"), `#!/bin/sh\necho "bwrap: refused" >&2; exit 1\n`);
    chmodSync(path.join(dir, "bwrap"), 0o755);
    vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
    const plain = createClaudeKit(spawn, { launch: testLaunch() }).makeRuntime(input);
    await expect(plain.start(rig.startOptions())).rejects.toMatchObject({ code: "sandbox_unusable" });
  });
});
