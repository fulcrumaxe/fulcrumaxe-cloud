import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkedVersion, loadUpdateState } from "../../src/update/versions.js";
import { realRun, updateWorld } from "../helpers/updateWorld.js";

/**
 * The update path against the real single-executable build from R6-1 (D#6 R6-2b, "real contracts"): the release file is a real SEA, the start
 * check runs its real `--version` and its real `doctor --sandbox-only`. Same conditions as test/release/seaReal.test.ts: Linux x64,
 * nodejs.org reachable, FX_SEA_SKIP_REAL=1 skips it.
 */
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "build-sea.mjs");
const REAL = process.platform === "linux" && process.arch === "x64" && process.env.FX_SEA_SKIP_REAL !== "1";

async function nodejsReachable(): Promise<boolean> {
  if (!REAL) return false;
  try {
    const response = await fetch("https://nodejs.org/dist/index.json", { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return response.ok;
  } catch {
    return false;
  }
}
const REACHABLE = await nodejsReachable();

describe.skipIf(!REACHABLE)("a real SEA through the updater", () => {
  let root: string;
  let sea: Buffer;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "fx-upd-sea-"));
    const out = path.join(root, "out");
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [SCRIPT, "--out-dir", out], { env: { PATH: process.env.PATH ?? "", FX_FORBID_MODEL_CALLS: "1", SOURCE_DATE_EPOCH: "1780000000", FX_SEA_NODE_CACHE_DIR: path.join(root, "node-cache") } }, (error) => (error === null ? resolve() : reject(error)));
    });
    sea = readFileSync(path.join(out, "fx-runner-linux-x64"));
  }, 300_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("installs it when it starts and its sandbox probe passes here; otherwise refuses and leaves the old link, and either way the link is never half-switched", async () => {
    const w = updateWorld({ current: "0.0.9" });
    w.tuf.add("v0.1.0/fx-runner-linux-x64", sea);
    const probe = await realRun(path.join(root, "out", "fx-runner-linux-x64"), ["doctor", "--sandbox-only"], 60_000);
    const result = await w.updater.applyLatest();
    if (probe.code === 0) {
      expect(result).toMatchObject({ ok: true, version: "0.1.0" });
      expect(linkedVersion(w.stateDir)).toBe("0.1.0");
      const started = await realRun(path.join(w.stateDir, "bin", "fx-runner"), ["--version"], 30_000);
      expect(started.code).toBe(0);
      expect(started.stdout).toBe("fx-runner 0.1.0 (2026-05-28)\n");
      expect(loadUpdateState(w.stateDir).previous).toBe("0.0.9");
    } else {
      expect(result).toMatchObject({ ok: false, code: "start_check_failed" });
      expect(linkedVersion(w.stateDir)).toBe("0.0.9");
    }
  }, 120_000);

  it("a SEA whose version line does not match the signed version is refused (a release file mislabelled as another version)", async () => {
    const w = updateWorld({ current: "0.0.9" });
    w.tuf.add("v0.2.0/fx-runner-linux-x64", sea);
    const result = await w.updater.applyLatest();
    expect(result).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(linkedVersion(w.stateDir)).toBe("0.0.9");
  }, 120_000);
});
