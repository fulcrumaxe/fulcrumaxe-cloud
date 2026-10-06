# Stats and KPIs (D#45)

This document describes the work-item stage model, the KPI views built on
top of it, and the `@fx/stats` formula registry that turns those views
into the figures the Stats app (D#37 WS-F10, ships at Launch) and the
`GET /api/v1/stats` route (D#45 S3) show.

Sources:
- `packages/db/migrations/0623_kpi_views.sql`
- `packages/core/src/work-items/stages.ts`
- `packages/core/src/work-items/recordStage.ts`
- `packages/stats/src/index.ts`
- `packages/stats/src/kpis.ts`
- `packages/stats/src/metrics.ts`
- `packages/stats/src/percentile.ts`

## The stage model

Every work item carries a `stage` column and an append-only
`work_item_transitions` history, written only by `recordStage()`
(`packages/core/src/work-items/stages.ts` and `recordStage.ts`, D#45 S1).
`T(s)` below always means "the earliest `at` of this item's transitions to
stage `s`", except `T(triaged)`, which is `work_items.created_at` --
`triaged` is the default stage and is never itself a *recorded* transition
under ordinary flow.

### Who stamps what

| `to_stage` | Caller | `at` |
|---|---|---|
| `discussing`, `spec_ready`, `closed` | D#2 H15 (and D#71 DS-2) | our clock |
| `in_progress` | D#2 H14, dispatch | our clock |
| `pr_opened` | D#2 H13, `pull_request.opened` webhook | the payload's `created_at` |
| `changes_requested`, `review_passed` | D#2 H14, a hosted reviewer's parsed verdict | the reviewer run's `ended_at` |
| `needs_human` | D#2 H14, after the fix-round limit | our clock |
| `merged`, `closed_unmerged` | D#2 H13, `pull_request.closed` webhook | the payload's `merged_at`/`closed_at` |
| `closed -> triaged` (reopen) | D#71's Discussions service | our clock |
| `needs_human -> discussing` (re-spec) | D#71's Discussions service | our clock |

### The graph (38 edges, D#45 Spec corrected by C1)

C1 added two edges to the Spec's original 36: `closed -> triaged` (a
closed Discussion or work item can be reopened, re-entering at `triaged`)
and `needs_human -> discussing` (an escalated item goes back to the panel
for a re-spec). A reopened item keeps every earlier transition row --
`T(s)` is still the earliest `at` for stage `s`, so reopening never moves
an earlier stamp backwards, and an item that ends in `closed` (rather than
`merged`) is excluded from every merge-anchored metric below.

| From | Legal `to` |
|---|---|
| `triaged` | `discussing`, `spec_ready`, `in_progress`, `closed` |
| `discussing` | `spec_ready`, `closed` |
| `spec_ready` | `in_progress`, `closed` |
| `in_progress` | `pr_opened`, `needs_human`, `closed` |
| `pr_opened` | `changes_requested`, `review_passed`, `needs_human`, `merged`, `closed_unmerged` |
| `changes_requested` | `changes_requested`, `review_passed`, `needs_human`, `merged`, `closed_unmerged` |
| `review_passed` | `review_passed`, `changes_requested`, `needs_human`, `merged`, `closed_unmerged` |
| `needs_human` | `in_progress`, `pr_opened`, `changes_requested`, `review_passed`, `merged`, `closed_unmerged`, `closed`, `discussing` |
| `merged` | `closed` |
| `closed_unmerged` | `in_progress`, `closed` |
| `closed` | `triaged` |

## The KPI views

`v_kpi_work_items` (one row per work item) and `v_kpi_runs` (one row per
agent run, `runtime IN ('local', 'production')` only) are `security_invoker`
views, granted `SELECT` to `app_user` only -- every read goes through the
querying tenant's own row-level security, the same as any other table.
`v_kpi_work_items` carries each item's `t_*` stage stamps, its earliest
verdict (`t_first_verdict`/`first_verdict_stage`), its `changes_requested`
and `needs_human` counts, and its ledger (`model_usd`, `compute_usd`) and
token totals. `v_kpi_runs` carries one row per run with its role, runtime,
status, timing and per-run ledger sums.

## The KPI registry

`@fx/stats`' `KPI_METRICS` (`packages/stats/src/metrics.ts`) has exactly
16 ids. Each is computed by the pure, I/O-free `computeKpis()` from
`v_kpi_work_items`/`v_kpi_runs`/`installations` rows plus a `{ from, to,
now }` window; "in window" means `from <= anchor < to`.

| Id | Formula |
|---|---|
| `lead_time_minutes` | `T(merged) - coalesce(T(spec_ready), created_at)`, over items merged in the window |
| `time_to_merge_minutes` | `T(merged) - T(pr_opened)`, over items merged in the window that ever had a `pr_opened` stamp |
| `spec_to_first_pr_minutes` | `T(pr_opened) - T(spec_ready)`, over items whose PR opened in the window (after their spec was ready) |
| `queue_wait_minutes` | `T(in_progress) - T(spec_ready)`, over items that entered `in_progress` in the window |
| `review_latency_minutes` | `T(first verdict) - T(pr_opened)`, over items whose first verdict landed in the window |
| `fix_rounds` | count of an item's `changes_requested` rows, over items merged in the window |
| `first_pass_review_rate` | of items merged in the window with >= 1 verdict, the share whose earliest verdict was `review_passed` |
| `escalation_rate` | of items whose PR opened in the window, the share with >= 1 `needs_human` row |
| `merged_count` | number of items merged in the window |
| `open_age_minutes` | `generated_at - created_at`, over items not currently `merged`/`closed_unmerged`/`closed` (ignores the window) |
| `run_success_rate` | per role, of runs that ended in the window (excluding `cancelled` and `refused_spend`), the share that `succeeded` |
| `model_usd_per_merged_pr` | total `model` ledger USD over items merged in the window, divided by that count |
| `compute_usd_per_merged_pr` | total `compute` ledger USD over items merged in the window, divided by that count |
| `tokens_per_merged_pr` | total tokens (`local`/`production` runs only) over items merged in the window, divided by that count |
| `abandoned_usd` | total `model` plus `compute` ledger USD over items abandoned (`closed_unmerged`) in the window |
| `first_pr_from_install` | minutes from the account's earliest `team` installation to its first PR at or after that install, against a 60-minute target; ignores the window entirely |

Items whose computed end stamp is earlier than their start stamp are left
out of the relevant distribution rather than reported as a negative
duration.

## Retention

- `work_item_transitions`, `agent_runs` and `ledger` are kept for the
  account's lifetime.
- `run_events` are kept **90 days** by default
  (`RUN_EVENTS_RETENTION_DAYS`, D#45 S8), or for the account's paid
  extension (D#45 S10, 365 days).
- Customers can export their run events at any time through D#45 S8's
  routes; reminder emails start at day 30 (`RUN_EVENTS_REMINDER_START_DAYS`,
  D#45 S9) and a final notice goes out before the purge.
- The purge itself is D#68 OPS-A1, which reads each account's own
  retention window from S8's `retentionDaysFor`.

## The figures contract

A tenant's own figures are available only through
`GET /api/v1/stats` (D#45 S3), scoped to that tenant's session or token.
Cross-tenant figures are available only through D#3's `public_figures`
view, limited to metrics marked `public` above, and only once at least 5
tenants contribute to a given figure.
