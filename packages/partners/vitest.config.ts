import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["../test-guard/src/setup.ts"],
    // P01 only scaffolds this package -- no src/ feature code and no test
    // files exist yet (each lands with its own later P-task, one
    // src/<feature> subfolder each). An empty suite must still exit 0.
    passWithNoTests: true,
  },
});
