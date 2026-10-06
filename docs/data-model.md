# Data model

The product stores every tenant's data in one shared Postgres schema, isolated by row-level security (RLS) rather than by per-tenant database or schema. `packages/db` owns the migration chain that creates this schema and the pool helpers application code uses to connect under the right role and session scope.

Sources:
- `packages/db/migrations/`
- `packages/db/src/migrate.ts`
- `packages/db/src/rlsInventory.ts`
- `packages/db/src/platformWideTables.ts`
- `packages/db/src/withTenant.ts`
- `packages/db/src/withPartner.ts`
- `packages/db/scripts/test-neon-shape.sh`

## Tables

Every `CREATE TABLE` in `packages/db/migrations/*.sql` at HEAD, one row each (49 tables, matching `grep -hoE '^CREATE TABLE (IF NOT EXISTS )?[a-z_]+' packages/db/migrations/*.sql`). "Tenancy scope" is which session setting the table's RLS policy keys on: `app.account_id` (tenant), `app.partner_id` (partner), or neither (platform-wide, per `packages/db/src/platformWideTables.ts`). "RLS" is whether the table has both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` set in its migration.

| Table | Migration | Tenancy scope | RLS enabled+forced |
|---|---|---|---|
| `partners` | `0001_core.sql` | platform-wide (`platform_ops`-only policy; `app_user` has no grant) | yes |
| `accounts` | `0001_core.sql` | tenant (`id = app.account_id`) | yes |
| `model_connections` | `0001_core.sql` | tenant | yes |
| `users` | `0001_core.sql` | tenant, but by membership (global identity row, visible only via an `EXISTS` join to `account_members` for the caller's `app.account_id`, not an `account_id` column of its own) | yes |
| `account_members` | `0001_core.sql` | tenant | yes |
| `invitations` | `0001_core.sql` | tenant | yes |
| `installations` | `0001_core.sql` | tenant | yes |
| `repos` | `0001_core.sql` | tenant | yes |
| `role_settings` | `0001_core.sql` | tenant | yes |
| `work_items` | `0001_core.sql` | tenant | yes |
| `agent_runs` | `0001_core.sql` | tenant | yes |
| `run_events` | `0001_core.sql` | tenant | yes |
| `spend_reservations` | `0001_core.sql` | tenant | yes |
| `ledger` | `0001_core.sql` | tenant | yes |
| `audit_log` | `0001_core.sql` | tenant (plus a `platform_ops` read-all policy) | yes |
| `routing_tables` | `0010_model_routing.sql` | platform-wide | no (exempted in `platformWideTables.ts`) |
| `routing_rows` | `0010_model_routing.sql` | platform-wide | no (exempted in `platformWideTables.ts`) |
| `sites` | `0100_sitekit.sql` | tenant | yes |
| `claims` | `0100_sitekit.sql` | tenant | yes |
| `site_versions` | `0100_sitekit.sql` | tenant | yes |
| `attestations` | `0100_sitekit.sql` | tenant | yes |
| `sync_passes` | `0100_sitekit.sql` | tenant | yes |
| `partner_members` | `0200_partners.sql` | partner | yes |
| `partner_branding` | `0200_partners.sql` | partner | yes |
| `partner_domains` | `0200_partners.sql` | partner | yes |
| `partner_retail_prices` | `0200_partners.sql` | partner | yes |
| `support_grants` | `0200_partners.sql` | tenant (`account_id` is the table's own key; a partner reads only the grants naming it) | yes |
| `support_access_log` | `0200_partners.sql` | tenant (append-only; a partner writes only through its own grant) | yes |
| `partner_escalations` | `0200_partners.sql` | partner | yes |
| `partner_audit_log` | `0200_partners.sql` | partner | yes |
| `decision_settings` | `0400_decisions.sql` | tenant | yes |
| `decision_receipts` | `0400_decisions.sql` | tenant | yes |
| `idempotency_keys` | `0600_api_core.sql` | tenant | yes |
| `stripe_webhook_events` | `0606_derived_account_status.sql` | platform-wide (`platform_ops`-only policy; no grant to `app_user`/`partner_user`) | yes |
| `sitekit_entitlements` | `0679_sitekit_billing.sql` | tenant (`app_user` SELECT only; the Stripe webhook writes as `platform_ops`) | yes |
| `sitekit_checkout_sessions` | `0679_sitekit_billing.sql` | tenant (insert-only; `app_user` SELECT only) | yes |
| `work_item_transitions` | `0610_work_item_stages.sql` | tenant | yes |
| `account_features` | `0611_exposure_audit.sql` | tenant | yes |
| `platform_audit` | `0611_exposure_audit.sql` | platform-wide (`platform_ops` reads, a dedicated `exposure_writer` role writes; exempted in `platformWideTables.ts`) | no (exempted; nullable `account_id`, cross-tenant by design) |
| `api_tokens` | `0616_api_tokens.sql` | tenant | yes |
| `discussion_counters` | `0618_discussions.sql` | tenant | yes |
| `discussions` | `0618_discussions.sql` | tenant | yes |
| `discussion_revisions` | `0618_discussions.sql` | tenant | yes |
| `discussion_comments` | `0618_discussions.sql` | tenant | yes |
| `spec_versions` | `0618_discussions.sql` | tenant | yes |
| `spec_corrections` | `0618_discussions.sql` | tenant | yes |
| `work_item_deps` | `0618_discussions.sql` | tenant | yes |
| `rate_limit_windows` | `0622_rate_limits.sql` (session buckets: `0700_session_rate_limits.sql`) | platform-wide (`platform_ops`-only policy; keyed by an opaque `bucket_key`, not `account_id`; no `app_user` grant at all; `session:` and `session-user:` keys are accepted only for the caller's own account) | yes |
| `domain_events` | `0627_webhooks.sql` | tenant | yes |
| `webhook_endpoints` | `0627_webhooks.sql` | tenant | yes |
| `webhook_deliveries` | `0627_webhooks.sql` | tenant | yes |

`0618_discussions.sql` (D#71 DS-1) is the Discussions-and-work-item store: `discussions`/`discussion_comments`/`discussion_revisions` mirror a Discussion's content and edit history, `discussion_counters` tracks per-discussion sequence counters, `spec_versions`/`spec_corrections` version a Discussion's frozen Spec text and later corrections to it, and `work_item_deps` records dependency edges between `work_items` rows; the same migration adds `work_items.discussion_id`/`parent_id`/`title` and `agent_runs.spec_version_id`, and a `platform_ops`-only `erase_discussion_content()` entry point. `0627_webhooks.sql` (`#173`) is the webhook outbox: `domain_events` is an append-style per-account event log (a private `bigserial` sequence plus a public `evt_<uuid>` id, so a subscriber's own ids never reveal platform-wide event volume), `webhook_endpoints` holds a tenant's registered delivery targets, and `webhook_deliveries` is the per-endpoint fan-out/retry queue the sweep (`@fx/webhooks`) claims from with `SKIP LOCKED`.

`packages/db/src/rlsInventory.ts`'s `findRlsViolations` is the mechanical version of the "RLS enabled+forced" column above: it scans `pg_class` for any `public` table missing either flag, excluding `schema_migrations` and `PLATFORM_WIDE_TABLES` (`routing_tables`, `routing_rows`, `platform_audit`), plus (since `#127`) every view/materialized view `app_user`/`partner_user` can read without `security_invoker`; its own test asserts an empty result against the real schema.

## Migration numbering

`packages/db/src/migrate.ts`'s `runMigrations` applies every `*.sql` file under `packages/db/migrations/` not already recorded in `schema_migrations`, sorted in filename order, each in its own transaction — filename order, not the order files were written or merged, is what actually runs.

The migrations at HEAD fall into three numbering styles:
- `0001`–`0011`: the original core-tenancy chain and its follow-on security/feature fixes (`0001_core.sql` through `0011_audit_write_role_settings_actions.sql`).
- `0100`, `0200`, `0400`: one file per epic, in a hundred-wide range reserved for that epic (site kit, partners, decisions respectively).
- `0600` and up (`0600_api_core.sql`, `0601_pin_model_connections_guard_write_search_path.sql`, `0604_session_epoch.sql`, `0605_execution_mode.sql`): a single flat four-digit sequence, one number per file, with no more per-epic ranges. `0600_api_core.sql`'s header records the switch to the `06xx` range to avoid colliding with an already-reserved `03xx` range; `0604_session_epoch.sql`'s header states the rule this later range actually runs on (D#94): a new migration takes the next number strictly above whatever is main's newest migration filename at merge time, re-checked at every rebase, because filename order and real applied order must agree once a database can receive files incrementally rather than as one fresh chain. `0605_execution_mode.sql`'s own header is a worked example: it was renumbered twice (from `0007`, then from `0603`) as it rebased across other PRs' merges, landing on `0605` — the next number free above main's newest at the point it actually merged. `0608_work_items_provenance_vocabulary.sql`'s own header is a second worked example, from the same rule's collision-avoidance side: it was written when `0606_derived_account_status.sql` was main's newest, which would make `0607` the next free number under rule R1, but it takes `0608` instead because a separate in-flight PR had already claimed `0607` for an unrelated table before this file's number was fixed.

## RLS conventions

Every per-tenant table follows the same pattern, laid out in `packages/db/migrations/0001_core.sql`'s file header and repeated at each table:

- `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY; ALTER TABLE <t> FORCE ROW LEVEL SECURITY;` — `FORCE` closes the gap where the table owner (the migration role itself, which owns every table) would otherwise bypass RLS by default.
- A `tenant_isolation` policy whose `USING`/`WITH CHECK` clause compares the row's `account_id` column against `NULLIF(current_setting('app.account_id', true), '')::uuid` — the session-local value `packages/db/src/withTenant.ts` sets via `SET LOCAL` for the duration of one transaction. A missing or empty setting resolves to `NULL`, which matches no `account_id`, so a connection with no tenant context set sees no tenant rows at all (fail closed).
- A composite foreign key on any table that references another tenant table: `FOREIGN KEY (account_id, <fk>) REFERENCES parent (account_id, id)`, with the parent carrying a matching `UNIQUE (account_id, id)`. `0001_core.sql`'s header explains why a plain `FOREIGN KEY (<fk>) REFERENCES parent (id)` is not enough — Postgres foreign-key checks run with elevated internal privilege that bypasses RLS, so an ordinary FK only proves the referenced id exists *somewhere*, not that it belongs to the same tenant; the composite form forces the child's `account_id` to match the parent's, so a cross-tenant reference fails at the constraint itself regardless of RLS.
- Column-level `GRANT`s where a role should only touch part of a row: for example `GRANT UPDATE (role) ON account_members TO app_user` (`0005_account_members_role_gate.sql`) and `GRANT SELECT (key_nonce) ON model_connections TO platform_ops` (`0006_model_connections_key_nonce_grant.sql`) — narrower than a table-wide grant, so a role that should only ever touch one column cannot be tricked (by its own bug, or a future caller) into writing or reading the rest of the row.

`packages/db/src/withPartner.ts` is the partner-side counterpart to `withTenant.ts`: it sets `app.partner_id` (and, when given, `app.user_id`) via `SET LOCAL`, and `0200_partners.sql`'s partner-scoped policies key on that setting the same way tenant policies key on `app.account_id`.

## Applying migrations without a superuser

Migrations are written to apply as the database's non-superuser owning role on hosted Postgres (Neon), not only on the superuser-owned clusters local development and CI use — introduced in `#92`. Several migrations that transfer function ownership to `platform_ops` need `platform_ops` to briefly hold `CREATE` on schema `public`, a privilege only available to a `CREATEROLE` role (never a superuser-only grant) under a specific, self-bracketed sequence: grant, do the ownership transfer, revoke. [`docs/ops/hosted-postgres.md`](ops/hosted-postgres.md) covers the full owner shape and the per-file bracket rule this depends on.

## Append-only evidence tables

Two tables exist to record what happened, not to be read back by application logic to decide what happens next:

- `ledger`: `app_user` holds only `SELECT, INSERT` on it (`0001_core.sql`) — no `UPDATE` or `DELETE` grant exists for any tenant-facing role, so a row, once written, cannot be edited or removed by the tenant that wrote it.
- `audit_log`: originally also writable by a plain `INSERT` grant, `#91` (`packages/db/migrations/0008_audit_log_append_only.sql`) revokes that grant from `app_user` outright and replaces it with two `SECURITY DEFINER` functions, `audit_write` and `audit_write_system`, both owned by `platform_ops`. `audit_write` is the only way `app_user` can still produce an `audit_log` row: it stamps `account_id` and `actor` from the caller's own session state (`app.account_id`, and `current_member_user_id()`) rather than trusting caller-supplied values, restricts `action` to a literal allowlist, and overwrites any caller-supplied `actor` key inside the payload. `audit_write_system` is the platform-only equivalent for a system/webhook actor.

## Tables with no application code at HEAD

None at this HEAD for `idempotency_keys`: `packages/api/src/idempotency.ts` (`#130`) now implements the read/write protocol the `0600_api_core.sql` migration's header anticipated.
