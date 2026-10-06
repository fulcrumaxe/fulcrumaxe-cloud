import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
const TSX_BIN = path.join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const SMOKE_SCRIPT = path.join(PACKAGE_ROOT, "src", "local", "smoke.ts");

/**
 * Spec H04 pass/fail 6: "It is skipped with exit 0 and a message when
 * FX_RUNTIME is not local." This test only ever exercises that skip path —
 * FX_RUNTIME is explicitly unset below, so the script returns before it
 * would touch the local runner or spend a single model token.
 */
describe("smoke:local skip behavior", () => {
  it("exits 0 with a skip message when FX_RUNTIME is not local", () => {
    const env = { ...process.env };
    delete env.FX_RUNTIME;
    const output = execFileSync(TSX_BIN, [SMOKE_SCRIPT], {
      env,
      encoding: "utf8",
    });
    expect(output).toContain("smoke:local skipped");
  });

  it("also skips when FX_RUNTIME is set to something other than local", () => {
    const output = execFileSync(TSX_BIN, [SMOKE_SCRIPT], {
      env: { ...process.env, FX_RUNTIME: "production" },
      encoding: "utf8",
    });
    expect(output).toContain("smoke:local skipped");
  });
});
