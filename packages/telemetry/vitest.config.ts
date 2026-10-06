import { defineConfig } from "vitest/config";

/**
 * D#68 OPS-T1: pure functions over strings, no Postgres and no network.
 * FX_FORBID_MODEL_CALLS=1 is set for the whole project so the model-call
 * guard (`../test-guard/src/setup.ts`) is live while these tests run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-guard/src/setup.ts"],
    env: { FX_FORBID_MODEL_CALLS: "1" },
  },
});
