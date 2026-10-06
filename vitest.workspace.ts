import { existsSync } from "node:fs";
import { defineWorkspace } from "vitest/config";

/**
 * Every project listed here gets the model-call guard's setup file wired
 * in (`packages/test-guard/src/setup.ts`), so no project can accidentally
 * call out to a model endpoint or spawn a `claude` binary while
 * FX_FORBID_MODEL_CALLS=1. New packages/apps must add a project here with
 * the same `setupFiles` entry.
 */
// D#37 WS-LV2: first-party apps import the shell's core modules as
// "../../core/x.js" (where the built dist puts them); in the source tree they
// are under shell/core/. Same map as apps/workspace/vitest.config.mjs. Kept as
// a constant so the inline workspace entry below stays a flat property list
// (packages/test-guard/test/workspace-coverage.test.ts parses it).
const workspaceCoreAlias = [
  { find: /^\.\.\/\.\.\/core\//, replacement: new URL("./apps/workspace/shell/core/", import.meta.url).pathname },
];

// packages/doc-templates is not listed on purpose: it is outside the root pnpm workspace (see
// pnpm-workspace.yaml) and runs on its own, with its own lockfile.

// scripts/ops and scripts/live are private directories: the public tree does not carry them, and a
// workspace project whose root is missing makes vitest fail. They are listed only where they exist.
const privateScriptProjects = [
  {
    test: {
      name: "ops-scripts",
      root: "scripts/ops",
      environment: "node",
      setupFiles: ["../../packages/test-guard/src/setup.ts"],
      include: ["*.test.mjs"],
    },
  },
  {
    test: {
      name: "live-scripts",
      root: "scripts/live",
      environment: "node",
      setupFiles: ["../../packages/test-guard/src/setup.ts"],
      include: ["*.test.mjs"],
    },
  },
].filter((project) => existsSync(new URL(`./${project.test.root}`, import.meta.url)));

export default defineWorkspace([
  {
    test: {
      name: "test-guard",
      root: "packages/test-guard",
      environment: "node",
      setupFiles: ["./src/setup.ts"],
    },
  },
  "packages/api",
  "packages/billing",
  "packages/core",
  "packages/db",
  "packages/decisions",
  "packages/design",
  "packages/discussions",
  "packages/env-build",
  "packages/env-network",
  "packages/env-presets",
  "packages/env-spec",
  "packages/features",
  "packages/gh-policy",
  "packages/github",
  "packages/model-call",
  "packages/model-connection",
  "packages/model-router",
  "packages/net-guard",
  "packages/partners",
  "packages/pipeline",
  "packages/plan-data",
  "packages/reconcile",
  "packages/roles",
  "packages/runner",
  "packages/runner-cloud",
  "packages/runner-protocol",
  "packages/runtime",
  "packages/sitekit-checks",
  "packages/sitekit-claims",
  "packages/sitekit-publish-gates",
  "packages/sitekit-template",
  "packages/spend",
  "packages/stats",
  "packages/telemetry",
  "packages/trust",
  "packages/webhooks",
  "packages/worker",
  {
    test: {
      name: "web",
      root: "apps/web",
      environment: "node",
      passWithNoTests: true,
      setupFiles: ["../../packages/test-guard/src/setup.ts"],
      // D#37 WS-C2 criterion 1: regenerates apps/web/app/_generated/
      // workspace-index.ts from the current apps/workspace tree before
      // any "web" project test runs -- see that file's own header for
      // why this can't just be the "prebuild" package.json script.
      globalSetup: ["./test/globalSetup.ts"],
    },
  },
  {
    // The repo's own ESLint rules (lint/*.mjs) have tests next to them, outside any package.
    test: {
      name: "lint-rules",
      root: "lint",
      environment: "node",
      include: ["*.test.mjs"],
      setupFiles: ["../packages/test-guard/src/setup.ts"],
    },
  },
  ...privateScriptProjects,
  {
    test: {
      name: "gh-proxy",
      root: "apps/gh-proxy",
      environment: "node",
      setupFiles: ["../../packages/test-guard/src/setup.ts"],
    },
  },
  {
    test: {
      name: "workspace",
      // D#37 WS-LV2: see workspaceCoreAlias above.
      alias: workspaceCoreAlias,
      root: "apps/workspace",
      environment: "node",
      setupFiles: ["../../packages/test-guard/src/setup.ts"],
      // D#37 WS-B: an inline project entry here does NOT pick up
      // apps/workspace/vitest.config.mjs's own `include` -- Vitest's
      // default include glob also matches any *.spec.* file, which sweeps
      // in apps/workspace/e2e/idle-network.spec.ts, a Playwright spec (run
      // by `pnpm --filter workspace e2e`, never vitest), and that fails
      // immediately outside Playwright's own runner. Scoped the same way
      // apps/workspace/vitest.config.mjs is, so both the root `pnpm test`
      // (this file) and a local `pnpm --filter workspace test` (that
      // file) stay in sync.
      include: ["test/**/*.test.mjs"],
    },
  },
]);
