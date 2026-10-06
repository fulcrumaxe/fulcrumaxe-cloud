import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";

/**
 * D#31 API-3a criterion 1 ("Real input"): `pnpm --filter @fx/api seed-dev`
 * seeds two accounts, each with 3 work items and 60 runs, into whatever
 * Postgres `DATABASE_URL` points at -- an unrestricted admin role, like
 * every pg test suite's own `admin` pool, so it inserts without RLS.
 * Dev-only: never point this at production (see `assertLocalDevTarget`). Afterward, `curl
 * localhost:3000/api/v1/runs` with a test-provider session cookie for the
 * printed owner should page through 60 rows (50 then 10), filterable by
 * `?work_item_id=`/`?status=`/`/work-items?repo_id=`/`?stage=`.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set (a local dev Postgres admin connection string).`);
  }
  return value;
}

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Fix round 1 (CWE-489 / OWASP A05): refuses to seed unless FX_SEED_DEV=1
 * is set and the target host is local.
 *
 * Fix round 2 (delta recheck on f7beb7a): fix round 1 only checked
 * `new URL(url).hostname`, but the driver (`pg` -> `pg-connection-string`)
 * parses query params into its resolved `config` FIRST and only falls
 * back to the URL's own hostname if that's absent -- so
 * `postgres://u@localhost/db?host=evil.example.com` looked local to the
 * guard while the actual connection went to `evil.example.com`. Reject
 * any `host`/`hostaddr` query param outright rather than trying to
 * out-parse the driver's own connection-string parser.
 *
 * D#31 C12 (API-3c): the #145 recheck found the round-2 check above
 * case-sensitive (`?HOST=` was not rejected by this guard). Not currently
 * exploitable -- the installed `pg-connection-string` only reads the
 * exact-case `host` key -- but the guard's own correctness shouldn't
 * depend on that driver detail staying case-sensitive, so compare
 * lowercased param keys instead of the two literal spellings.
 */
export function assertLocalDevTarget(url: string): void {
  if (process.env.FX_SEED_DEV !== "1") throw new Error("refusing to seed: set FX_SEED_DEV=1 (local dev databases only)");
  const parsed = new URL(url);
  const paramKeys = new Set(Array.from(parsed.searchParams.keys(), (key) => key.toLowerCase()));
  if (paramKeys.has("host") || paramKeys.has("hostaddr")) {
    throw new Error("refusing to seed: host/hostaddr query params are not allowed (they can override the connection target)");
  }
  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`refusing to seed non-local host: ${host}`);
}

const WORK_ITEM_STAGE_CYCLE = [
  "triaged",
  "discussing",
  "spec_ready",
  "in_progress",
  "pr_opened",
  "review_passed",
  "merged",
] as const;
const RUN_STATUS_CYCLE = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
const RUN_ROLE_CYCLE = ["build", "review", "triage"] as const;

async function seedOneAccount(pool: Pool, index: number): Promise<void> {
  const accountId = randomUUID();
  const userId = randomUUID();
  const installationId = randomUUID();
  const repoId = randomUUID();

  // D#69 (migration 0606): `status` is derived from `stripe_customer_id`
  // (plus marker columns this script never sets) -- the explicit
  // `status = 'active'` literal has to agree with what a set
  // `stripe_customer_id` and no markers derive to, or the INSERT trigger
  // rejects the row.
  await pool.query(
    `INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`,
    [accountId, `cus_seed_${accountId}`],
  );
  await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `seed-${index}@example.test`]);
  await pool.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    accountId,
    userId,
  ]);
  await pool.query(
    `INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`,
    [installationId, accountId, 1000 + index],
  );
  await pool.query(
    `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`,
    [repoId, accountId, installationId, 2000 + index],
  );

  const workItemIds: string[] = [];
  for (let w = 0; w < 3; w++) {
    const workItemId = randomUUID();
    const stage = WORK_ITEM_STAGE_CYCLE[w % WORK_ITEM_STAGE_CYCLE.length]!;
    await pool.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage)
       VALUES ($1, $2, $3, 'feature', $4, 'internal', $5)`,
      [workItemId, accountId, repoId, 100 + w, stage],
    );
    workItemIds.push(workItemId);
  }

  const baseTime = Date.now();
  let firstItemRunId: string | undefined;
  for (let r = 0; r < 60; r++) {
    const runId = randomUUID();
    const workItemId = workItemIds[r % workItemIds.length]!;
    if (workItemId === workItemIds[0] && firstItemRunId === undefined) {
      firstItemRunId = runId;
    }
    const status = RUN_STATUS_CYCLE[r % RUN_STATUS_CYCLE.length]!;
    const role = RUN_ROLE_CYCLE[r % RUN_ROLE_CYCLE.length]!;
    // Strictly decreasing, one second apart, so pagination has a stable,
    // deterministic order to page through.
    const createdAt = new Date(baseTime - r * 1000);
    await pool.query(
      `INSERT INTO agent_runs
         (id, account_id, work_item_id, role, runtime, status, usd, tokens_in, tokens_out, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'local', $5, $6, $7, $8, $9, $9)`,
      [runId, accountId, workItemId, role, status, ((r % 5) + 1) / 2, 1000 + r, 500 + r, createdAt],
    );
  }

  // D#45 S3 criterion 10: give account A a real merged item, through
  // `recordStage` only (SECURITY: no second writer of `work_items.stage`)
  // -- otherwise `merged_count` and every merge-anchored KPI stay at their
  // empty default and `/api/v1/stats` never shows more than zeros.
  const mergeSteps: { toStage: string; reviewer?: 'code' }[] = [
    { toStage: 'discussing' },
    { toStage: 'spec_ready' },
    { toStage: 'in_progress' },
    { toStage: 'pr_opened' },
    { toStage: 'review_passed', reviewer: 'code' },
    { toStage: 'merged' },
  ];
  const client = await pool.connect();
  try {
    for (const [i, step] of mergeSteps.entries()) {
      await recordStage(client, {
        workItemId: workItemIds[0]!,
        toStage: step.toStage as never,
        at: new Date(baseTime - (mergeSteps.length - i) * 60_000),
        source: 'control_plane',
        sourceRef: randomUUID(),
        reviewer: step.reviewer ?? null,
      });
    }
  } finally {
    client.release();
  }
  // The installation predates the PR (D#2's own 60-minute target), so
  // `first_pr_from_install.status` reads "met", not "pending"/"no_install".
  await pool.query(`UPDATE installations SET created_at = $1 WHERE id = $2`, [
    new Date(baseTime - (mergeSteps.length + 30) * 60_000),
    installationId,
  ]);
  // D#2 H05b: budget must be explicit and distinct per kind here -- both
  // rows sharing the same run_id and defaulting to 'model' would collide
  // with the UNIQUE(account_id, run_id, budget) constraint.
  await pool.query(
    `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'workflow', 1.5, $2, 'model'), ($1, 'compute', 'workflow', 0.75, $2, 'foreground_compute')`,
    [accountId, firstItemRunId ?? null],
  );

  console.log(
    `seeded account ${index}: ${accountId} (owner user ${userId}), repo ${repoId}, 3 work items, 60 runs, 1 merged`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  assertLocalDevTarget(databaseUrl);
  const pool = createPool(databaseUrl);
  try {
    await seedOneAccount(pool, 0);
    await seedOneAccount(pool, 1);
  } finally {
    await pool.end();
  }
}

// Run only when executed directly (`tsx scripts/seed-dev.ts`), not on
// import -- packages/api/test/seed-dev.test.ts imports assertLocalDevTarget
// directly and must not trigger a live seed attempt as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
