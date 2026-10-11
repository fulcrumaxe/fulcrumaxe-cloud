import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { runCli } from "../../src/cli.js";
import { startFakeCloud, type FakeCloud } from "../helpers/fakeCloud.js";

export const CODE = `fxrr_${"A1b2C3d4".repeat(5)}`;

export interface Rig {
  cloud: FakeCloud;
  dir: string;
  run: (argv: string[], over?: { fetchFn?: typeof fetch; now?: () => Date; hostname?: string }) => Promise<{ code: number; out: string; err: string }>;
  /** `serverMode` is the mode the code was minted for (default: the same as `mode`). */
  register: (mode?: string, serverMode?: "subscription" | "api_key") => Promise<{ code: number; out: string; err: string }>;
}

/** A fresh state directory (inside a throwaway parent, so the CLI creates it) and a fake cloud for each test. */
export function useRig(): Rig {
  const rig = {} as Rig;
  let parent = "";
  beforeEach(async () => {
    parent = mkdtempSync(path.join(tmpdir(), "fxr-cli-"));
    rig.dir = path.join(parent, "state");
    rig.cloud = await startFakeCloud();
    rig.cloud.validCodes.add(CODE);
    rig.run = async (argv, over = {}) => {
      let out = "";
      let err = "";
      const code = await runCli({ argv, home: undefined, stateDirOverride: rig.dir, hostname: "studio-mac.local", stdout: (t) => (out += t), stderr: (t) => (err += t), ...over });
      return { code, out, err };
    };
    rig.register = (mode = "api_key", serverMode) => {
      rig.cloud.codeModes.set(CODE, serverMode ?? (mode === "subscription" ? "subscription" : "api_key"));
      return rig.run(["register", "--code", CODE, "--credential-mode", mode, "--cloud-url", rig.cloud.origin]);
    };
  });
  afterEach(async () => {
    await rig.cloud.close();
    rmSync(parent, { recursive: true, force: true });
  });
  return rig;
}
