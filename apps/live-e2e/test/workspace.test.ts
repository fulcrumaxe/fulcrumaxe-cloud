import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./helpers.js";

describe("workspace registration", () => {
  const repoRoot = join(PACKAGE_ROOT, "..", "..");

  it("vitest.workspace.ts lists apps/live-e2e", () => {
    expect(readFileSync(join(repoRoot, "vitest.workspace.ts"), "utf8")).toContain('"apps/live-e2e"');
  });

  it("its vitest config collects only test/**/*.test.ts and wires in the model-call guard", () => {
    const config = readFileSync(join(PACKAGE_ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain('include: ["test/**/*.test.ts"]');
    expect(config).toMatch(/setupFiles\s*:\s*\["\.\.\/\.\.\/packages\/test-guard\/src\/setup\.ts"\]/);
    expect(config.match(/include:\s*\[[^\]]*\]/)?.[0]).not.toMatch(/spec/);
  });
});
