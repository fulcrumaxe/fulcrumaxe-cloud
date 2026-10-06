// apps/workspace/vitest.config.mjs
//
// D#37 WS-B: vitest's default include glob (`**/*.{test,spec}.*`) also
// matches e2e/idle-network.spec.ts -- that file is a Playwright spec (run
// by `pnpm e2e`, not `pnpm test`), not a vitest test, and importing it
// under vitest fails immediately (Playwright's test.describe() refuses to
// run outside its own runner). Scoping `include` to test/**/*.test.mjs
// keeps vitest to Gate 1's unit tests only.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // First-party apps import the shell's core modules as "../../core/x.js"
    // (where the built dist puts them). In the source tree they live under
    // shell/core/, so unit tests that load apps/_lib/api.js need the same map.
    alias: [{ find: /^\.\.\/\.\.\/core\//, replacement: fileURLToPath(new URL("./shell/core/", import.meta.url)) }],
  },
  test: {
    include: ["test/**/*.test.mjs"],
  },
});
