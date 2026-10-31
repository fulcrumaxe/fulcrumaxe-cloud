import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["../../packages/test-guard/src/setup.ts"],
    // test/built.test.ts runs a real `next build`.
    testTimeout: 60000,
    hookTimeout: 300000,
  },
});
