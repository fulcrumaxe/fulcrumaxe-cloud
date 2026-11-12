import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The repo's model-call guard (see vitest.workspace.ts). It is test tooling only; nothing in src/ imports it.
    setupFiles: ["../test-guard/src/setup.ts"],
    restoreMocks: true,
    // Many files here drive real child processes, real bwrap and real repositories. Under load (a busy host, a
    // hosted CI merge queue) those take several seconds, so the 5 s default dropped merges. Hooks get the same.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
