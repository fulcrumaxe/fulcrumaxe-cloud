import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { jobEnvFor } from "../src/sandbox/allowances.js";

/**
 * D#6 R7e B6, with the real pnpm: the names a job's environment uses for the per-repo package store and for store integrity are the ones this pnpm reads.
 * pnpm 11 ignores the `npm_config_` forms of these two settings and honours `pnpm_config_`. The job environment is built by the runner's own code
 * (`jobEnvFor` then `cleanEnv`), so a wrong name there fails here; the controls show the old names are really ignored by this pnpm.
 */
const probe = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 });
const hasPnpm = probe.status === 0 && /^\d+\.\d+\.\d+/.test(probe.stdout.trim());
const major = hasPnpm ? Number(probe.stdout.trim().split(".")[0]) : 0;

const scratch = mkdtempSync(path.join(tmpdir(), "fx-r7e-pnpm-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function pnpmGet(env: Record<string, string>, key: string): string {
  const out = spawnSync("pnpm", ["config", "get", key], { env, cwd: scratch, encoding: "utf8", timeout: 60_000 });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim();
}

describe.skipIf(!hasPnpm || major < 11)("R7e B6: the job environment's package store settings are read by the real pnpm", () => {
  const store = path.join(scratch, "pnpm-store", "repo-id-1");

  it("a job env makes pnpm report the per-repo store and turns store integrity checks on", () => {
    const env = cleanEnv({ mode: "subscription" }, { jobEnv: jobEnvFor({ tempDir: path.join(scratch, "rn-1"), store, commandTimeoutS: 1800 }) });
    expect(pnpmGet(env, "store-dir")).toBe(store);
    expect(pnpmGet(env, "verify-store-integrity")).toBe("true");
  });

  it("control: without the store in the job env, pnpm does not report the per-repo store", () => {
    const env = cleanEnv({ mode: "subscription" }, { jobEnv: jobEnvFor({ tempDir: path.join(scratch, "rn-2"), commandTimeoutS: 1800 }) });
    expect(pnpmGet(env, "store-dir")).not.toBe(store);
  });

  it("control: the old npm_config_ names are ignored by this pnpm, so they could not have worked", () => {
    const env = { ...cleanEnv({ mode: "subscription" }), npm_config_store_dir: store, npm_config_verify_store_integrity: "true" };
    expect(pnpmGet(env, "store-dir")).not.toBe(store);
    expect(pnpmGet(env, "verify-store-integrity")).not.toBe("true");
  });
});
