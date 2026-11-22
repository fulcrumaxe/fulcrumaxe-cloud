import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installModelCallGuard, type InstalledGuard } from "../../../test-guard/src/guard.js";
import { resolveClaudePath } from "../../src/engines/claude/pin.js";
import { tempDir } from "../helpers/tempTree.js";
import { osToolbin, STAND_IN } from "./helpers/scriptedCli.js";

/**
 * The OS-sandbox half of the engine comparison in vmJob.real.test.ts starts the CLI stand-in on the host. The repo's model-call guard (on whenever FX_FORBID_MODEL_CALLS=1, which hosted CI sets)
 * refuses to start any program whose own name is the CLI's, and the runner starts the REAL PATH of what it finds under that name. The stand-in used to be a file called after the CLI, so on hosted CI
 * the run ended on "blocked child_process spawn". This needs no VM and no model: every program started here is a script this file wrote.
 */
const started = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: { PATH: process.env["PATH"] ?? "" }, timeout: 20_000 }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
  });

describe("the OS-sandbox tool directory under the model-call guard", () => {
  let guard: InstalledGuard;
  let root: string;
  beforeEach(() => {
    root = tempDir("fxr-osbin-guard-");
    guard = installModelCallGuard({ FX_FORBID_MODEL_CALLS: "1" });
  });
  afterEach(() => guard.uninstall());

  it("the stand-in the runner locates is not named for the CLI, so the guard lets it start", async () => {
    const dir = osToolbin(root, '#!/usr/bin/env python3\nprint("2.1.295 (stand-in)")\n', "/bin/true");
    if (dir === undefined) return; // a machine without bwrap, socat, git, sh, env or python3 has no such directory; the control below still runs
    const located = resolveClaudePath(dir);
    expect(path.basename(located)).toBe(STAND_IN);
    expect(located).toBe(realpathSync(path.join(dir, STAND_IN)));
    expect(await started(located, ["--version"])).toContain("stand-in");
  });

  it("the old layout (a program that is itself named for the CLI) is refused by the guard: the failure this fixes", async () => {
    const dir = path.join(root, "old-toolbin");
    mkdirSync(dir);
    const file = path.join(dir, "claude");
    writeFileSync(file, "#!/bin/sh\necho started\n");
    chmodSync(file, 0o755);
    expect(resolveClaudePath(dir)).toBe(realpathSync(file));
    await expect(started(realpathSync(file), ["--version"])).rejects.toThrow(/test-guard: blocked child_process spawn/);
  });
});
