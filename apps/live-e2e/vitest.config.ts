import { defineConfig } from "vitest/config";

// Only test/**/*.test.ts: the Playwright *.spec.ts files that later tasks add under packs/ must never be
// collected by vitest (they fail outside Playwright's own runner).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["../../packages/test-guard/src/setup.ts"],
  },
});
