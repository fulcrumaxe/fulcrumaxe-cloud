import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The repo's model-call guard (see vitest.workspace.ts). It is test tooling only; nothing in src/ imports it.
    setupFiles: ["../test-guard/src/setup.ts"],
    restoreMocks: true,
  },
});
