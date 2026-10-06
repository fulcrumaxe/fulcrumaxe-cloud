#!/usr/bin/env -S tsx
/**
 * `pnpm --filter @fx/model-router eval:bootstrap` -- Spec H22 "Bootstrap by
 * offline eval". Owner-machine-only: replays a fixed task list across
 * Haiku 4.5, Sonnet 5 and Opus 5 using H04's local runner, scores each run,
 * and writes default-table/v1.json plus RESULTS.md.
 *
 * Never run by `pnpm test` (test/evalBootstrap.test.ts only exercises the
 * guard and the pure scoring/write logic below with an injected fake
 * AgentRuntime -- zero model tokens, no real replay).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalRunnerAllowed } from '@fx/runtime/src/local/guard.js';
import type { AgentRuntime, NormalizedEvent } from '@fx/runtime/src/types.js';
import { computeModelUsd } from '@fx/spend';
import { assertRowMeetsFloor } from '../src/floors.js';
import type { ModelId, RoutingRow, Size } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The three model tiers, and the runtime-layer alias each maps to. H04's
 * local runner takes a `model` string it hands straight to the SDK -- this
 * mapping lives in the eval script, not in @fx/model-router's own types,
 * because it is a runtime-invocation detail, not a routing concept. */
const RUNTIME_MODEL_ALIAS: Record<ModelId, string> = {
  'haiku-4.5': 'haiku',
  'sonnet-5': 'sonnet',
  'opus-5': 'opus',
};

export interface EvalTask {
  id: string;
  role: string;
  size: Size;
  prompt: string;
  roleCard: string;
  capUsd: number;
  /** The verdict a successful replay's AGENT_OUTPUT envelope must carry. */
  expectedVerdict: string;
}

export interface ReplayResult {
  success: boolean;
  usd: number;
}

export function readTasks(tasksDir: string): EvalTask[] {
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(tasksDir, f), 'utf8')) as EvalTask);
}

/** Runs one task through one model via the given runtime, and scores it
 * with the same success definition buildProposal uses (verdict pass; PR
 * merged and fix rounds are not modeled by a single offline replay, so a
 * bootstrap run's success is verdict-only). */
export async function replayTask(runtime: AgentRuntime, task: EvalTask, model: ModelId): Promise<ReplayResult> {
  const events: NormalizedEvent[] = [];
  await runtime.start({
    runId: `eval-${task.id}-${model}`,
    role: task.role,
    roleCard: task.roleCard,
    prompt: task.prompt,
    model: RUNTIME_MODEL_ALIAS[model],
    capUsd: task.capUsd,
    onEvent: (event) => {
      events.push(event);
    },
  });

  let usd = 0;
  let verdict: unknown;
  for (const event of events) {
    if (event.usage) usd += computeModelUsd(model, event.usage);
    if (event.costUsd) usd += event.costUsd;
    if (event.agentOutput?.verdict) verdict = event.agentOutput.verdict;
  }
  return { success: verdict === task.expectedVerdict, usd };
}

interface TaskModelScore {
  task: EvalTask;
  model: ModelId;
  result: ReplayResult;
}

/** Pure: turns per-(task, model) scores into a routing table (cheapest
 * model per (role, size) that succeeded on every task at that pair) plus a
 * RESULTS.md body. No I/O, no model call -- this is what
 * test/evalBootstrap.test.ts exercises directly. */
export function buildTableFromScores(scores: readonly TaskModelScore[]): { rows: RoutingRow[]; resultsMd: string } {
  const pairs = new Map<string, TaskModelScore[]>();
  for (const s of scores) {
    const key = `${s.task.role}|${s.task.size}`;
    const group = pairs.get(key) ?? [];
    group.push(s);
    pairs.set(key, group);
  }

  const rows: RoutingRow[] = [];
  const resultLines = ['# Offline eval bootstrap results', ''];
  for (const [key, group] of pairs) {
    const [role, size] = key.split('|') as [string, Size];
    const byModel = new Map<ModelId, TaskModelScore[]>();
    for (const s of group) {
      const arr = byModel.get(s.model) ?? [];
      arr.push(s);
      byModel.set(s.model, arr);
    }
    let chosen: ModelId | undefined;
    let chosenCost = Infinity;
    for (const [model, group2] of byModel) {
      const allSucceeded = group2.every((s) => s.result.success);
      const totalCost = group2.reduce((sum, s) => sum + s.result.usd, 0);
      resultLines.push(`- ${role}/${size}/${model}: succeeded=${allSucceeded} cost=$${totalCost.toFixed(4)}`);
      if (allSucceeded && totalCost < chosenCost) {
        chosen = model;
        chosenCost = totalCost;
      }
    }
    if (chosen) {
      // Security fix round (CWE-693): floor validation used to run only
      // from test files. Without this, a floored role (e.g.
      // security-reviewer) whose cheapest-passing replay happened to be
      // Haiku would get written straight into default-table/v1.json --
      // the file that ships as the actual default routing table.
      assertRowMeetsFloor(role, chosen);
      rows.push({ role, size, model: chosen, rationale: `offline eval bootstrap: cheapest model that passed every task at ${role}/${size}` });
    }
  }

  return { rows, resultsMd: resultLines.join('\n') + '\n' };
}

async function main(): Promise<void> {
  assertLocalRunnerAllowed(process.env);

  const { createLocalRuntime } = await import('@fx/runtime/src/local/index.js');
  const runtime = createLocalRuntime(process.env);
  const tasks = readTasks(path.join(here, 'tasks'));
  const models: ModelId[] = ['haiku-4.5', 'sonnet-5', 'opus-5'];

  const scores: TaskModelScore[] = [];
  for (const task of tasks) {
    for (const model of models) {
      const result = await replayTask(runtime, task, model);
      scores.push({ task, model, result });
    }
  }

  const { rows, resultsMd } = buildTableFromScores(scores);
  writeFileSync(path.join(here, '..', 'default-table', 'v1.json'), JSON.stringify({ version: 1, fetchedPricesAt: new Date().toISOString().slice(0, 10), rows }, null, 2));
  writeFileSync(path.join(here, 'RESULTS.md'), resultsMd);
  console.log(`eval:bootstrap wrote ${rows.length} rows from ${tasks.length} tasks x ${models.length} models`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('eval:bootstrap failed:', error);
    process.exitCode = 1;
  });
}
