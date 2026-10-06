import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Io } from "../src/cli.js";
import type { Pack } from "../src/manifest.js";
import type { HostProbe, NeedsContext } from "../src/needs.js";
import type { Target } from "../src/targets.js";

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const GOOD_HOST: HostProbe = { loadavg1: () => 1, memAvailableBytes: () => 16 * 1024 ** 3 };

export function makePack(overrides: Partial<Pack> & { id: string }): Pack {
  return {
    rows: ["X1"],
    tier: "smoke",
    tags: ["@api"],
    targets: ["staging"],
    destructive: false,
    model_spend: false,
    projects: ["desktop"],
    needs: [],
    probes: [],
    cost: { class: "free", est_usd: 0, est_sandbox_min: 0 },
    retry: 0,
    runs_last: false,
    paths: [],
    ...overrides,
  };
}

export function makeTarget(overrides: Partial<Target> = {}): Target {
  return {
    name: "staging",
    origin: "https://staging.example.test",
    origin_env: "LIVE_E2E_STAGING_ORIGIN",
    project_id_env: "LIVE_E2E_STAGING_PROJECT_ID",
    project_id: "prj_Staging1",
    protected: true,
    env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
    budget_usd: { default: 0, max: 8 },
    ...overrides,
  };
}

export function needsCtx(env: Record<string, string | undefined> = {}, host: HostProbe = GOOD_HOST): NeedsContext {
  return { env, host };
}

export function tmpDir(prefix = "t1a_live_e2e_"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A scratch package root holding the REAL target files (copied) and the given packs, so CLI tests run the
 * real production target and the real loaders against fixture packs.
 */
export function scratchRoot(packs: Pack[]): string {
  const root = tmpDir();
  cpSync(join(PACKAGE_ROOT, "targets"), join(root, "targets"), { recursive: true });
  for (const p of packs) {
    mkdirSync(join(root, "packs", p.id), { recursive: true });
    writeFileSync(join(root, "packs", p.id, "pack.json"), JSON.stringify(p, null, 2));
  }
  return root;
}

/** Fictional deployment values for the four target variables; the real ones are never in this tree. */
export const TARGET_ENV: Record<string, string> = {
  LIVE_E2E_STAGING_ORIGIN: "https://staging.example.test",
  LIVE_E2E_STAGING_PROJECT_ID: "prj_Staging1",
  LIVE_E2E_PRODUCTION_ORIGIN: "https://production.example.test",
  LIVE_E2E_PRODUCTION_PROJECT_ID: "prj_Production1",
};

export function makeIo(root: string, extraEnv: Record<string, string | undefined> = {}, host: HostProbe = GOOD_HOST) {
  const env = { ...TARGET_ENV, ...extraEnv };
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { root, cwd: root, env, host, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  return { io, out, err };
}
