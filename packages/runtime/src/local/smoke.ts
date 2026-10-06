#!/usr/bin/env node
/**
 * `pnpm --filter @fx/runtime smoke:local` — Spec H04 pass/fail 6.
 *
 * Manual, owner-machine-only. Runs one real turn through the local runner
 * with the cheapest model that works, and records the result as a new
 * fixture. Never invoked from `pnpm test` — this file is not imported by
 * anything under `test/`, only executed directly by the `smoke:local` npm
 * script (and by a test that checks its skip behavior without setting
 * FX_RUNTIME=local, which spends nothing).
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalRuntime } from "./index.js";
import { redactError } from "../redact.js";
import type { NormalizedEvent } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (process.env.FX_RUNTIME !== "local") {
    console.log("smoke:local skipped — set FX_RUNTIME=local to run it (owner machine only).");
    process.exitCode = 0;
    return;
  }

  const model = process.env.FX_SMOKE_MODEL ?? "haiku";
  const runtime = createLocalRuntime(process.env);
  const events: NormalizedEvent[] = [];
  const runId = randomUUID();

  await runtime.start({
    runId,
    role: "smoke",
    roleCard: "smoke test — reply with a single word",
    prompt: "Reply with exactly the word: ok",
    model,
    workdir: process.cwd(),
    capUsd: 0.05,
    onEvent: (event) => {
      events.push(event);
    },
  });

  const outDir = path.join(here, "..", "..", "fixtures", "agent-outputs", "smoke");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${runId}.jsonl`);
  await writeFile(outFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  console.log(`smoke:local recorded ${events.length} events to ${outFile}`);
}

main().catch((error) => {
  // createLocalRuntime already redacts errors thrown during a run, but this
  // catch is the last stop before a console log, so redact defensively
  // here too — a rejection from anywhere else in main() (e.g. a fs error
  // whose path happened to embed FX_SMOKE_MODEL-adjacent env) gets the same
  // treatment (Spec H04 fix-round item 4).
  const secrets = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN];
  console.error("smoke:local failed:", redactError(error, secrets));
  process.exitCode = 1;
});
