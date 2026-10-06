#!/usr/bin/env node
/**
 * `pnpm --filter @fx/runtime construct:local` — exercised by the Discussion's
 * umbrella-level real-world verification: `VERCEL=1 pnpm --filter @fx/runtime
 * construct:local` must exit non-zero with `LocalRunnerRefused` in stderr.
 * Construction only — never calls `start`, so this never spends a model
 * token regardless of which env it runs under.
 */
import { createLocalRuntime } from "./index.js";

try {
  createLocalRuntime(process.env);
  console.log("local runner constructed OK");
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
