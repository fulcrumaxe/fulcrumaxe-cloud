import { defineConfig } from "vitest/config";

/**
 * D#66: no Postgres, no network -- every test here is a pure function over
 * strings/fake DNS lookups, so this package needs none of
 * packages/runner's [pg] globalSetup machinery. Wired into the model-call
 * guard (`../test-guard/src/setup.ts`) like every other project in
 * vitest.workspace.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-guard/src/setup.ts"],
  },
});
