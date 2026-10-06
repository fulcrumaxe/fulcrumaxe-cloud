import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**", "node_modules/**"],
    environment: "node",
    setupFiles: ["../test-guard/src/setup.ts"],
  },
});
