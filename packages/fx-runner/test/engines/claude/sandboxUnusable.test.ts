import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobDirFor, outcomeOf } from "../../../src/engines/claude/engine.js";
import { RUN_ID, engineFor, makeRig } from "./rig.js";

/**
 * The start-up probe at the engine: when bubblewrap refuses a no-op under the job's own rules, the run ends with the closed code `sandbox_unusable`
 * before the agent is started, instead of the agent looping on Bash calls that all fail. The `bwrap` on the agent's PATH is a script here, so this holds on any host;
 * the real bubblewrap is in `bashSandbox.bwrap.test.ts`.
 */
function rigWithBwrap(script: string) {
  const rig = makeRig({});
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
});
