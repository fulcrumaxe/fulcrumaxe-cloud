import { defineConfig } from "vitest/config";

/** Real-Chromium tier. Not part of `pnpm test`; run with `pnpm --filter @fx/sitekit-checks test:browser`. */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.test.ts"],
    environment: "node",
    setupFiles: ["../../../test-guard/src/setup.ts"],
    testTimeout: 30_000,
  },
});
