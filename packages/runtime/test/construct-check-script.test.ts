import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = path.join(PACKAGE_ROOT, "src", "local", "construct-check.ts");

function run(env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX_BIN, [SCRIPT], { env, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

/**
 * Umbrella real-world verification (D#2605 Spec): `VERCEL=1 pnpm --filter
 * @fx/runtime construct:local` must exit non-zero with `LocalRunnerRefused`
 * in stderr. This only ever constructs — never calls `start` — so it spends
 * no model tokens under any env.
 */
describe("construct:local script", () => {
  it("exits non-zero with LocalRunnerRefused in stderr when VERCEL=1", () => {
    const result = run({ ...process.env, VERCEL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LocalRunnerRefused");
  });

  it("exits 0 on a clean, non-Vercel, non-production env with FX_RUNTIME=local", () => {
    const env = { ...process.env };
    delete env.VERCEL;
    delete env.VERCEL_ENV;
    delete env.VERCEL_URL;
    delete env.VERCEL_REGION;
    env.NODE_ENV = "development";
    // Spec H04 fix-round 2 item 4: FX_RUNTIME=local is now a required
    // opt-in, not just an absence of deployed-environment signals.
    env.FX_RUNTIME = "local";
    const result = run(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("constructed OK");
  });

  it("exits non-zero on an otherwise-clean env when FX_RUNTIME=local was never set (fix-round 2 item 4)", () => {
    const env = { ...process.env };
    delete env.VERCEL;
    delete env.VERCEL_ENV;
    delete env.VERCEL_URL;
    delete env.VERCEL_REGION;
    delete env.FX_RUNTIME;
    env.NODE_ENV = "development";
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LocalRunnerRefused");
    expect(result.stderr).toContain("FX_RUNTIME=local");
  });
});
