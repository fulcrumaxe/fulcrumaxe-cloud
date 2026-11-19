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
- `packages/db/migrations/1002_agent_run_last_alive.sql`
- `packages/db/migrations/1003_verify_stage.sql`
- `packages/db/migrations/1004_runner_browser_capabilities.sql`
- `packages/db/migrations/1005_verify_stage_sweep.sql`
- `packages/db/migrations/1011_verify_again.sql`
- `packages/db/migrations/1012_plane_push_reverify.sql`
- `packages/db/migrations/1013_verify_hold_reason.sql`
- `packages/db/migrations/1016_proposal_verify_fair_order.sql`
- `packages/db/migrations/1017_sitekit_role_routing.sql`
- `packages/db/migrations/1018_run_checks_reason_no_change.sql`
- `packages/db/migrations/1019_sitekit_preview.sql`
- `packages/db/migrations/1020_verify_sign_in_expiry.sql`
- `packages/db/migrations/1021_plane_merge_overlap_facts.sql`
- `packages/db/migrations/1022_criteria_verifications.sql`
- `packages/db/migrations/1023_merge_conflict_round_expected_signals.sql`
- `packages/db/migrations/1026_engine_audit_actions.sql`
- `packages/db/migrations/1027_engine_bridge.sql`
- `packages/db/migrations/1029_engine_commands.sql`
- `packages/db/migrations/1030_engine_decisions.sql`
- `packages/db/migrations/1031_engine_halt.sql`
- `packages/db/migrations/1032_engine_plan.sql`
- `packages/db/migrations/1033_engine_commands_ask_index.sql`
- `packages/db/migrations/1034_engine_halt_stamp_exact.sql`
- `packages/db/migrations/1035_machine_tables.sql`
- `packages/db/migrations/1036_onboarding_tables.sql`
- `packages/db/migrations/1037_device_registration.sql`
- `packages/db/migrations/1038_engine_halt_by.sql`
- `packages/db/migrations/1039_engine_notice_panels.sql`
- `packages/db/migrations/1040_runner_sandbox_inventory.sql`
- `packages/db/migrations/1041_sandbox_commands.sql`
- `packages/reconcile/src/jobs/machinePrune.ts`
- `packages/reconcile/src/jobs/onboardingPrune.ts`
- `packages/runner-cloud/src/deviceFlow.ts`

## Tables

The migrations create 215 tables at HEAD (`grep -hoE '^CREATE TABLE (IF NOT EXISTS )?[a-z_]+' packages/db/migrations/*.sql | sort -u | wc -l`). The table below lists the core and tenant-facing ones and the pipeline's merge, correction, memory, assistant and post-merge verify tables; it is not the whole set. The rest are runner, capacity, environment-build, plan-import, staff and sweep bookkeeping tables, each created by one migration whose header comment says what it holds, and each follows the same RLS rule. `rlsInventory.ts` (below) checks all of them, listed here or not. "Tenancy scope" is which session setting the table's RLS policy keys on: `app.account_id` (tenant), `app.partner_id` (partner), or neither (platform-wide, per `packages/db/src/platformWideTables.ts`). "RLS" is whether the table has both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` set in its migration.

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
| `decision_ask_settings` | `0812_decision_ask_settings.sql` | tenant | yes |
| `action_rules` | `0847_action_rules.sql` | tenant (append-only; `app_user` SELECT and INSERT, owner or admin to insert) | yes |
| `context_rules` | `0871_context_rules.sql` | tenant (`app_user` SELECT only; written by `context_rule_save` and `context_rule_remove`: owner or admin for repo scope, any member for item scope) | yes |
| `ask_routes` | `0836_ask_routes.sql` | tenant | yes |
| `discovery_settings` | `0849_discovery_settings.sql` | tenant | yes |
| `plan_writeback_settings` | `0967_plan_writeback_settings.sql` | tenant (append-only: `app_user` SELECT and INSERT; owner or admin to write; version trigger; no UPDATE or DELETE) | yes |
| `plan_writeback_merges` | `0988_plan_writeback_receipt.sql` | tenant (append-only: `app_user` SELECT and INSERT; no UPDATE or DELETE; one row per write-back, the gate's own fact that it merged it, which the receipt keys on) | yes |
| `plan_writeback_receipts` | `0988_plan_writeback_receipt.sql` | tenant (`app_user` SELECT only; inserted by `plan_writeback_receipt_write` alone; one row per write-back, tying it to its `merge_after_reviews` receipt; no UPDATE or DELETE) | yes |
| `setup_requests` | `0856_setup_requests.sql`, `0874_setup_request_lister.sql`, `0877_setup_request_repaused.sql` | tenant (`app_user` SELECT, INSERT and a column-limited UPDATE; owner or admin to propose or decide; no DELETE; the cross-account due list is `setup_request_list_due`, run-writer only) | yes |
| `plane_parity_checks` | `0951_plane_parity_checks.sql` | tenant (`app_user` SELECT, INSERT and a column-limited UPDATE; no DELETE, rows go with the pairing; the cross-account due list is `plane_parity_list_due`, run-writer only) | yes |
| `repo_instruction_files` | `0998_repo_instruction_files.sql` | tenant (`app_user` SELECT, INSERT and a column-limited UPDATE; no DELETE, rows go with the repository; the cross-account due list is `repo_instruction_list_due`, run-writer only) | yes |
| `branch_cleanups` | `0886_branch_cleanup_lister.sql` | tenant (`app_user` SELECT and INSERT; no UPDATE or DELETE; the cross-account due list is `branch_cleanup_list_due`, run-writer only) | yes |
| `pr_slot_reconciles` | `0894_pr_slot_reconcile.sql` | tenant (`app_user` SELECT, INSERT and UPDATE; one row per item, the last time GitHub was asked about its pull request; the cross-account due list is `pr_slot_reconcile_list_due`, run-writer only) | yes |
| `discovery_runs` | `0859_discovery_runs.sql`, `0952_discovery_sweep.sql`, `0955_discovery_sweep_paging.sql` | tenant (`app_user` SELECT, a four-column INSERT and column-scoped state UPDATE; no DELETE). `0952` adds the trigger `sweep` (its reference is the UTC day, or the ISO week for a weekly repository, so a period is queued once) and `discovery_sweep_list_due`, the cross-account list of repositories whose sweep is due (own NOLOGIN role `discovery_sweep_lister`, `EXECUTE` for the run-writer login only, period names cut in SQL in UTC; `0955` pages it by a keyset cursor and leaves out a repository whose discovery is off or whose account is not active) | yes |
| `discovery_analyses` | `0950_discovery_analyses.sql`, `0959_discovery_analysis_list_ineligible.sql` | tenant (`app_user` SELECT, a four-column INSERT that always starts `queued`, column-scoped UPDATE moving only forward; one row per repository and default-branch head; no DELETE; the cross-account due list is `discovery_analysis_list_due`, run-writer only; `0959` lists a waiting analysis whose repository is no longer eligible too, so the pass can end it). The same migration adds `proposals.analysis_refs` (at most 10 `path:start-end` refs, writable by `plan_importer`) and `proposal_title_norm(text)` (the one title normaliser: a functional index on `(repo_id, norm)`, `EXECUTE` for the roles that write proposals only) | yes |
| `proposal_intake_events` | `0861_proposal_intake.sql` | tenant (`app_user` SELECT and a four-column INSERT; no UPDATE or DELETE) | yes |
| `idempotency_keys` | `0600_api_core.sql` | tenant | yes |
| `stripe_webhook_events` | `0606_derived_account_status.sql` | platform-wide (`platform_ops`-only policy; no grant to `app_user`/`partner_user`) | yes |
| `sitekit_entitlements` | `0679_sitekit_billing.sql` | tenant (`app_user` SELECT only; the Stripe webhook writes as `platform_ops`) | yes |
| `sitekit_checkout_sessions` | `0679_sitekit_billing.sql` | tenant (insert-only; `app_user` SELECT only) | yes |
| `sitekit_previews` | `1019_sitekit_preview.sql` | tenant (`app_user` SELECT only; one row per site kit preview request, moving `requested`, `running`, then `finished`, `failed` or `void`; written only through the `sitekit_preview_request`, `sitekit_preview_start` and `sitekit_preview_finish` definers, owned by `platform_ops`) | yes |
| `sitekit_preview_stamps` | `1019_sitekit_preview.sql` | platform-wide (no grant to `app_user`; one row per GitHub user id and per installation id that has had a preview, with no foreign key so removing the installation does not give the preview back) | yes |
| `work_item_transitions` | `0610_work_item_stages.sql` | tenant | yes |
| `platform_ref_pushes` | `0956_platform_ref_pushes.sql` | tenant (`app_user` SELECT only; append-only; the only writer is the `record_platform_ref_push` definer, called by the gh-proxy login after GitHub accepts a push) | yes |
| `work_item_driver_event_details` | `0957_work_item_driver_event_details.sql` | tenant (`app_user` SELECT and INSERT; no UPDATE or DELETE; one row per driver event that has a conflict-file list or a base branch, written in the event's transaction; both are checked in SQL) | yes |
| `work_item_supersedes` | `0851_retire_superseded_work_item.sql` | tenant (`app_user` SELECT only; the only writer is the `retire_superseded_work_item` definer) | yes |
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
| `aap_instances` | `0837_aap.sql` | tenant (writes only through the `aap_definer` functions; `app_user` reads without the credential hash) | yes |
| `action_approvals` | `0837_aap.sql` | tenant (same; `app_user` reads every column but the sealed arguments, which only an owner or admin opens through `aap_arguments_get`) | yes |
| `aap_idempotency` | `0838_aap_idempotency.sql` | by instance, definer-only (`app_user` has no grant) | yes |
| `aap_provisioner_tokens` | `0840_aap_management.sql` | tenant (writes only through the definers; `app_user` reads without the hash) | yes |
| `work_item_corrections` | `0780_work_item_corrections.sql` | tenant (`app_user` SELECT only; the body and its hash are written once; status moves along fixed steps `proposed` to `accepted`, `rejected` or `superseded`, then `applied`, only through the three `work_item_correction_*` definers, each writing its `audit_log` row in the same transaction) | yes |
| `memory_entries` | `0793_memory_entries.sql` | tenant (`app_user` SELECT only; one row per version of an entry, so an edit inserts the next version and marks the old one `superseded`; written only through the `memory_*` definers; a proposal expires in 14 days and is never recalled) | yes |
| `memory_entry_evidence` | `0972_memory_entry_evidence.sql` | tenant (`app_user` SELECT of four columns and INSERT of three, the pipeline's policy; no UPDATE or DELETE) | yes |
| `merge_queue_entries` | `0824_merge_queue.sql` | tenant (`app_user` SELECT, INSERT, UPDATE; one row per pull request waiting to merge; a partial unique index allows one `in_flight` row per repository, which is the merge slot, and a trigger fixes the legal state steps; the cross-account sweep reads only five columns through its own definer role) | yes |
| `head_refreshes` | `0824_merge_queue.sql` | tenant (`app_user` SELECT and INSERT; append-only record of a platform refresh of a pull request head) | yes |
| `work_item_criteria_verifications` | `1022_criteria_verifications.sql` | tenant (`app_user` SELECT and INSERT only: no UPDATE and no DELETE; one row per work item, head sha and reviewer role recording that a person confirmed the criteria that reviewer could not verify; a unique key refuses a second row for the same item, head and role, and `verified_at` is always the database clock) | yes |
| `merge_conflict_rounds` | `0948_merge_conflict_rounds.sql`, `1023_merge_conflict_round_expected_signals.sql` | tenant (`app_user` SELECT, INSERT and a four-column UPDATE: run, resulting sha, outcome, end time; one row per conflict, renumber or delta-review round of a queue entry; `expected_signals` is a nullable list of check and status names written by the INSERT and never changed afterwards) | yes |
| `repo_merge_leases` | `0975_repo_merge_leases.sql` | tenant (`app_user` SELECT, INSERT, UPDATE, DELETE; one row per repository, a direct merge's lease; a row past `lease_until` is dead and the next taker overwrites it) | yes |
| `plane_merge_orders` | `0910_plane_merge_orders.sql`, `1021_plane_merge_overlap_facts.sql` | tenant (`app_user` SELECT, INSERT, UPDATE; the cloud's record that a paired item's public pull request waits for its own runner to merge it; holds shas and progress, no contents, paths or credential) | yes |
| `work_item_driver_events` | `0709_work_item_driver_events.sql` | tenant (`app_user` SELECT and INSERT; no UPDATE or DELETE; the stage driver's own record of what it decided, such as a gate outcome, a fix round or a merge) | yes |
| `run_checks` | `0888_run_checks.sql` | tenant (`app_user` SELECT only; one row per run, written once by `agent_run_writer` when the runner reports the check's result: exit code, duration, timeout, skipped count and a redacted summary of at most 4096 characters) | yes |
| `capacity_queue` | `0941_capacity_queue.sql` | tenant (`app_user` SELECT only; inserted by the `capacity_queue_definer` role for a run start that was refused for capacity; its settings are in `capacity_queue_settings`) | yes |
| `assistant_conversations` | `0973_assistant_conversations.sql` | tenant (`app_user` SELECT and INSERT; visible to the creator and to an owner or admin while the account is active; one row per conversation with its cap, what is spent, what is held and a turn count, no message text; no UPDATE: `assistant_conversation_charge` and `assistant_conversation_settle` move the money) | yes |
| `assistant_conversation_holds` | `0973_assistant_conversations.sql` | by conversation, definer-only (`app_user` has no grant; one row per admitted turn, settled at most once, released if unsettled after 20 minutes) | yes |
| `assistant_link_codes` | `0971_assistant_delegation_token.sql` | by device code, definer-only (`app_user` has no grant; `assistant_link_start`, `assistant_link_approve` and `assistant_link_redeem` run the device link that hands a delegation token to a runner; the device code is stored as its SHA-256) | yes |
| `verify_settings` | `1003_verify_stage.sql` | tenant (`app_user` SELECT, INSERT and a column-limited UPDATE; only an owner or admin of the account may write, through a policy that joins `account_members`; one row per repository, and no row means the post-merge verify stage is off; `enabled_since` (`1005_verify_stage_sweep.sql`) is stamped by a trigger on the off-to-on move only) | yes |
| `verify_batches` | `1003_verify_stage.sql` | tenant (`app_user` SELECT, INSERT of two columns, UPDATE of status and closure; a batch is opened and closed by the row that opens it) | yes |
| `verify_rows` | `1003_verify_stage.sql` | tenant (`app_user` SELECT, INSERT of the identity columns and the journeys, and a column-limited UPDATE; one row per attempt at a merged pull request, moving one way through `pending`, `deploying`, `running` and ending `verified`, `failed` or `unverified`, with `verify_rows_guard` refusing any other move) | yes |
| `verify_deploy_orders` | `1004_runner_browser_capabilities.sql` | tenant (`app_user` SELECT, INSERT, UPDATE; the cloud's record that a runner on the repository's own machine should deploy one merge commit, with no column for a command or credential; a trigger lets the cloud place and end an unclaimed order and a runner only claim and report on its own, with at most 3 attempts) | yes |
| `engine_bridge_settings` | `1027_engine_bridge.sql` | tenant (`app_user` SELECT, INSERT and UPDATE; one row per account holding the watch and operate switches, both off by default, with a check that operate needs watch; an owner or admin writes it, on a session, never a token) | yes |
| `engine_bridge_repos` | `1027_engine_bridge.sql` | tenant (`app_user` SELECT, INSERT, DELETE; the repositories an account ticked for the engine bridge) | yes |
| `engine_sessions`, `engine_events`, `engine_agents`, `engine_lanes`, `engine_gate_receipts`, `engine_asks`, `engine_session_gaps`, `engine_agent_usage`, `engine_repo_quota` | `1027_engine_bridge.sql` | tenant (`app_user` SELECT only; written only by the `engine_bridge_definer` functions, chiefly `engine_events_ingest`, which a runner reaches through its signed session; the event body is held to closed shapes of ids, enums, counts and timestamps; `engine_events` older than 30 days is deleted by `engine_events_prune`) | yes |
| `engine_commands` | `1029_engine_commands.sql` | tenant (`app_user` SELECT and INSERT, plus UPDATE of four columns; an owner or admin inserts a pending command and may cancel it while pending, the runner's session moves its own rows from pending to delivered and then one ack; `kind` and `args` are a closed set; no DELETE) | yes |
| `engine_decisions` | `1030_engine_decisions.sql` | tenant (`app_user` SELECT and INSERT; one receipt per repo, decision type and request key, inserted by a verified runner session; the `subject` is a closed object of ids and enums; no UPDATE, no DELETE) | yes |
| `engine_decision_answers` | `1030_engine_decisions.sql` | tenant (`app_user` SELECT and INSERT; at most one answer per decision, written by an owner or admin, and only for a decision that was asked; final) | yes |
| `engine_repo_controls` | `1031_engine_halt.sql`, `1038_engine_halt_by.sql` | tenant (`app_user` SELECT only; the per-repo halt marker with `halted_at`, `halted_by` (the user who set the halt, null while not halted and for a halt set before `1038`) and a `halt_epoch` that only ever goes up; set and cleared only through the `engine_halt_set` and `engine_halt_clear` functions owned by `engine_halt_definer`) | yes |
| `engine_plan_chunks`, `engine_plan_snapshots` | `1032_engine_plan.sql` | tenant (`app_user` SELECT only; the chunks of a plan snapshot still arriving, and the newest complete snapshot per session and plan date; both are pruned after 14 days by `engine_plan_prune`) | yes |
| `machine_provider_credentials` | `1035_machine_tables.sql` | tenant (`app_user` SELECT on every column except the three sealed ones, INSERT, and a column-limited UPDATE; a person's Hetzner Cloud token, sealed in the app; one active row per account and provider, and removing it sets the sealed columns to NULL; the only reader of the sealed columns is `machine_credential_use`) | yes |
| `managed_servers` | `1035_machine_tables.sql` | tenant (`app_user` SELECT, INSERT and a column-limited UPDATE; a Hetzner Cloud server created with a stored credential, with a status that moves from `creating` toward `ready`, `deleted`, `failed` or `orphaned`, and the prices stamped at creation, which no grant lets the app change) | yes |
| `project_placements` | `1035_machine_tables.sql` | tenant (`app_user` SELECT, INSERT, UPDATE, DELETE; which machine runs a repository's engine, `auto` or `person` placed; both keys lead with `account_id`, and a runner holds at most one placement) | yes |
| `machine_login_requests` | `1035_machine_tables.sql` | tenant (`app_user` SELECT on every column except the two sealed ones, INSERT and UPDATE; a Claude sign-in link and its one-time code, sealed, living at most 10 minutes; a finished request holds no sealed value) | yes |
| `machine_usage_daily` | `1035_machine_tables.sql` | tenant (`app_user` SELECT only; raw token counts per machine, repository, day, source and model tier, one row per key, with no money figure) | yes |
| `onboarding_tracks` | `1036_onboarding_tables.sql` | tenant (`app_user` SELECT, INSERT, UPDATE; which track, `engine` or `pipeline`, an account chose, one row per account and track) | yes |
| `project_setups` | `1036_onboarding_tables.sql` | tenant (`app_user` SELECT, INSERT, UPDATE; one repository's setup, step by step, through the phases `survey`, `plan`, `install`, `await_merge`, `finish`, `done` and `removed`; a partial unique index allows one live setup per account and repository) | yes |
| `project_drafts` | `1036_onboarding_tables.sql` | tenant (`app_user` SELECT, INSERT, UPDATE; the PRD text, at most 200,000 characters, and the roadmap, a closed shape of at most 200 rows, that a person reviews before the engine is installed; versioned per repository) | yes |
| `runner_device_codes` | `1036_onboarding_tables.sql`, `1037_device_registration.sql` | tenant, with a pending code reachable only by a definer (`app_user` SELECT on the non-secret columns of a row whose account is its own, and nothing else; the row has no account until a person approves it, the policy refuses a row with none, and both codes are stored only as 64-character hex hashes) | yes |
| `runner_device_attempts` | `1037_device_registration.sql` | tenant, with no `app_user` grant at all (the typed codes that matched nothing, one row per wrong attempt and account; only the device-flow definers read or write it) | yes |
| `engine_releases` | `1036_onboarding_tables.sql` | platform data under row security (every account's session may SELECT; only `platform_ops` may INSERT, and UPDATE only `withdrawn_at`; one row per published engine version with its commit, tarball hash and minimum runner protocol) | yes |
| `runner_sandboxes` | `1040_runner_sandbox_inventory.sql` | tenant (`app_user` SELECT only; the sandboxes a runner reports, metadata only, at most 200 rows per runner by construction (`slot` is 0 to 199); replaced whole by the `runner_sandboxes_record` definer, which names the runner from the verified session) | yes |
| `runner_sandbox_reports` | `1040_runner_sandbox_inventory.sql` | tenant (`app_user` SELECT only; one row per runner that has reported, with the time of its last report, so an empty list differs from never having reported) | yes |
| `sandbox_commands` | `1041_sandbox_commands.sql` | tenant (`app_user` SELECT and INSERT, no DELETE; one row per signed stop, delete or reap command, which is also the record of who asked; an owner or admin inserts and may cancel, the runner's own session may move only its own rows' `state`, `delivered_at`, `acked_at` and `refusal`) | yes |

`api_tokens` (`0616_api_tokens.sql`) gained three columns in `0971_assistant_delegation_token.sql`: `delegated`, the repository it is bound to and a client id. A check constraint fixes what a delegated row may be: only the scopes `read` and `corrections:write`, and at most one hour of life.

`0618_discussions.sql` (D#71 DS-1) is the Discussions-and-work-item store: `discussions`/`discussion_comments`/`discussion_revisions` mirror a Discussion's content and edit history, `discussion_counters` tracks per-discussion sequence counters, `spec_versions`/`spec_corrections` version a Discussion's frozen Spec text and later corrections to it, and `work_item_deps` records dependency edges between `work_items` rows; the same migration adds `work_items.discussion_id`/`parent_id`/`title` and `agent_runs.spec_version_id`, and a `platform_ops`-only `erase_discussion_content()` entry point. `0627_webhooks.sql` (`#173`) is the webhook outbox: `domain_events` is an append-style per-account event log (a private `bigserial` sequence plus a public `evt_<uuid>` id, so a subscriber's own ids never reveal platform-wide event volume), `webhook_endpoints` holds a tenant's registered delivery targets, and `webhook_deliveries` is the per-endpoint fan-out/retry queue the sweep (`@fx/webhooks`) claims from with `SKIP LOCKED`.

`verify_rows` and its siblings (`1003`-`1013`, and `1020` below) store the post-merge verify stage described in [the architecture](architecture.md#pipeline). Later migrations add to `verify_rows` and `verify_settings`: the runner's browser method and driver (`1006_runner_browser_playwright_capability.sql`, `1007_verify_browser_driver.sql`), an audit row for each settings write (`1008_verify_settings_audit.sql`), the stored account check (`1009_verify_account_check.sql`), `checks_only` for the Spec criteria left to the other checks (`1010_verify_visible_criteria.sql`), `attempt` so a person's "Verify again" opens a new row while the old one stays as history, with at most one unfinished row per merge (`1011_verify_again.sql`), and `hold_reason` and `hold_since` saying why a `deploying` row is waiting (`1013_verify_hold_reason.sql`).

`1026` to `1034`, `1038` and `1039` are the engine bridge (#990, #1001, #998, #993, #992, #1004, #1017, #1024, #1046, #1056); `1028` is not used (the plan snapshot moved to `1032`). `1033_engine_commands_ask_index.sql` (#1017) adds a partial index on `engine_commands` for the answers to one ask, so the command list's `ask_id` filter reads by ask. `1034_engine_halt_stamp_exact.sql` (#1024) changes the halt trigger so any session that names a tenant gets exactly the current epoch stamped on a new command, whatever it passed in, while a session with no tenant keeps the higher of the two. `1026_engine_audit_actions.sql` adds nine actions to `audit_write` (`engine_bridge.settings_changed`, `engine_bridge.data_deleted`, `engine_command.issued`, `engine_command.acked`, `engine_command.cancelled`, `engine_decision.recorded`, `engine_decision.answered`, `engine_halt.set`, `engine_halt.cleared`), with payloads of ids and enums only. `1027` also creates the NOLOGIN role `engine_bridge_definer`, which owns the ingest and delete functions and reads only the few columns it needs, and `1031` adds `engine_halt_definer`, whose five functions are checked by `packages/db/scripts/test-neon-shape.sh`. The halt marker is read by `BEFORE INSERT` triggers on `engine_decisions` and `engine_commands`, which raise `HX409` while a repo is halted; they take the marker's row lock `FOR SHARE`, so a halt that commits first is always seen. `1040_runner_sandbox_inventory.sql` (#1066) adds the four host-limit columns to `runner_facts` (`max_vms`, `max_vcpus`, `max_memory_mb`, `bootable_templates`; null or empty means never reported) and the two sandbox tables above. Both are written only by two `SECURITY DEFINER` functions owned by `runner_facts_definer`, `runner_sandbox_facts_record` and `runner_sandboxes_record`, which refuse unknown keys, a name outside the VM helper's id pattern, a state outside the closed set, more than 200 rows, duplicate names and any runner whose hello declared a protocol below 21; `platform_ops` has no privilege on either table. All of it is routing and display data, never a security input. `1041_sandbox_commands.sql` (#1071) adds `sandbox_commands` and widens the closed capability list, and `runner_capabilities_record`, by `sandbox_commands_v1`. A command's `kind` is `stop_sandbox`, `delete_sandbox` or `reap_sandboxes` (a name for the first two only), its `nonce` is unique because it is the runner's single-use key, and its life is at most 600 seconds. A trigger lets the state move one way only: pending, delivered, then applied or refused, or pending, then expired or cancelled.

`1038_engine_halt_by.sql` (#1046) adds `halted_by` to `engine_repo_controls`. `1039_engine_notice_panels.sql` (#1056) adds two pure functions, `engine_kind_panels(kind)` (the panels an engine event kind touches; null for a kind that does not exist) and `engine_panels_union(kinds, usage_bearing)` (the union for one batch, in a fixed order, naming every panel when any kind is unknown), both executable only by `engine_bridge_definer`. It re-creates `engine_events_ingest` with one change, that the single `engine.changed` row it writes per stored batch also carries `panels`, and it adds `engine.changed` to the types the `domain_events_nudge` trigger sends `NOTIFY fx_account_nudge` for. See [the architecture](architecture.md#the-engine-bridge) for how the pieces move.

`1035_machine_tables.sql` (#1032) adds the five machine tables above and the NOLOGIN role `machine_ops`, which owns four functions. `machine_credential_use(credential id)` is the one reader of a credential's sealed columns: it reads the session's own account, returns nothing for a removed credential or a deleted account, and the caller unseals in memory; the one caller is `packages/model-connection/src/machineOps.ts`, which writes the `server.unsealed` audit row first (#1057). The other three, `machine_login_requests_prune`, `machine_usage_prune` and `machine_servers_prune`, each take a batch size. They clear a login request's sealed columns once it has expired and delete it 7 days later, delete usage rows older than 400 days, and delete servers deleted more than 400 days ago. The reconciler's `machine_prune` job (`packages/reconcile/src/jobs/machinePrune.ts`) calls them every 5 minutes. The migration also replaces `audit_write` with the 1026 list plus eighteen actions for onboarding, project setup and machines (for example `machine_credential.added`, `server.create_confirmed`, `server.unsealed` and `machine.login_started`).

`1036_onboarding_tables.sql` (#1033) adds five tables (the six rows above, less `runner_device_attempts`), the NOLOGIN role `onboarding_ops` (the migration raises if it ends up with any privileged attribute) and two pure shape checks, `project_roadmap_valid` and `runner_device_facts_valid`. `onboarding_tracks`, `project_setups` and `project_drafts` carry the same tenant policy as the machine tables, `runner_device_codes` the same with a clause that refuses a row with no account, and `engine_releases` a platform policy. A device code's two hashes are 64 lowercase hex characters by CHECK, so a plaintext code cannot be written by mistake, and `expires_at` is at most 10 minutes after `created_at` by CHECK. A pending code has no account, no approver and no approval time; an approved or consumed one has all three. The device facts are a closed object (`hostname`, `os`, `arch`, `kvm`, `ip_country`) because the approval page shows them to a person. Two retention functions, `runner_device_codes_prune` (24 hours after a code expired) and `project_drafts_prune` (30 days after a draft became final), are called in batches, 1,000 by default, by the reconciler's `onboarding_prune` job (`packages/reconcile/src/jobs/onboardingPrune.ts`). `1036` does not touch `audit_write`: the actions it needs are in the `1035` list.

`1037_device_registration.sql` (#1034) adds `start_ip_hash`, `last_polled_at` and `runner_id` to `runner_device_codes`, the `runner_device_attempts` table, and six `SECURITY DEFINER` functions owned by `onboarding_ops`, so no app session can read, list, claim or change a code that has no account yet. `runner_device_start` stores a new code and enforces the start limits, 10 an hour per address hash and a global figure passed in (the default is 1,000), both counted on stored rows, so a refused start leaves nothing behind. `runner_device_lookup`, `runner_device_approve` and `runner_device_deny` need the session's user to be an owner or admin of an active account. They serialise on a per-account advisory lock and count a typed code that matches nothing in `runner_device_attempts`; from the sixth such attempt in 15 minutes they answer `limited`, whatever code is typed. Approve creates the `runners` row with `allowed_repo_ids` empty and writes the `runner.device_approved` and `runner.registered` audit rows in the same transaction. `runner_device_key` hands the signed poll's route the stored key and nothing else, and `runner_device_poll` answers `pending`, `slow_down` (polled faster than the interval), `approved`, which marks the code consumed in the same statement so the registration is handed out once, or the reason the code is over (`expired`, `denied`, `consumed`). The typed code is stored as an HMAC-SHA256 under the server's `FX_DEVICE_CODE_KEY`, the machine's secret code as a plain SHA-256 (`packages/runner-cloud/src/deviceFlow.ts`; the trust rules are in [the security model](security.md#the-device-code-flow)).

Two other recent migrations touch existing tables. `1002_agent_run_last_alive.sql` adds `agent_runs.last_alive_at` and the run's own silence and run-time limits, written only through the `agent_run_alive_mark` function, so a durable sweep can end a hosted run whose starting process is gone. `1012_plane_push_reverify.sql` adds four nullable columns to the plane-push attempt so a push report that GitHub had not yet confirmed can be checked again against the head and tip that same report named. `1014`-`1016` change which proposals `proposal_verify_list_due` lists: Local-only repositories are included, newest first, and fair across accounts.

`1038_engine_halt_by.sql` (#1046) adds `engine_repo_controls.halted_by`, a nullable reference to `users`, with a CHECK that it is null unless `halted_at` is set. `engine_halt_set` stamps it from the session's own user id, which `engine_halt_assert_person` has just proven to be an owner or admin of the account; there is no parameter, so a caller cannot name someone else. `engine_halt_clear` sets it back to null. Both functions are replaced in place, so their owner and grants do not change, and `app_user` still cannot write the table. A halt set before the migration keeps a null `halted_by`: nothing is guessed. The engine repos read joins `account_members` on the repo's own account, so a user of another account is never named.

`1019_sitekit_preview.sql` (#928) adds the site kit's one-time, read-only preview. `spend_reservations.purpose` gains `sitekit_preview`, counted by its own `sitekit_preview_daily_compute_usd()` function so these previews never use the onboarding preview's daily allowance. `sitekit_preview_request` is for a session owner or admin only, needs the model cap confirmed as exactly 20, and refuses a used stamp (`PX409`) or a full day (`PX429`); `sitekit_preview_finish` hands the stamp back only when the preview's agent never started (`void`). `1020_verify_sign_in_expiry.sql` (#947) adds `runners.verify_sign_in` and `runners.verify_sign_in_at` (`ok`, `expiring_soon`, `expired` or `missing`, both set or both null), written by the `runner_verify_sign_in_record` function for the runner named in the session (the `platform_ops` role has a table-wide grant on `runners`, so it can also write them; the migration header notes this) and only from protocol 18, through a role of its own (`runner_verify_sign_in_definer`). On `verify_rows` it adds the hold reason `needs_sign_in`, the reason code `sign_in_expired` and the `sign_in_parks` counter (0 to 10), and `verify_rows_guard` now allows one more move, `running` to `pending`, only when written with `hold_reason = 'needs_sign_in'`.

`1021_plane_merge_overlap_facts.sql` (#963) lets a blocked plane merge order carry the runner's overlap facts: the shape check on the four conflict columns of `plane_merge_orders` now also accepts them on a `blocked` order that never had a write credential, when the outcome code is `overlap_unreviewed` or `ordered_resource_out_of_order`, and the closed capability list of `runner_capabilities_record` grows to fourteen values with `overlap_facts_v1`. `1022_criteria_verifications.sql` (#975) adds `work_item_criteria_verifications`, the stored half of a person's sign-off on criteria a reviewer said it could not verify. It is bound to the exact head it was taken on, so a later push to the pull request leaves it inert, and it holds at most 10 criteria of at most 400 characters each. `1023_merge_conflict_round_expected_signals.sql` (#966) adds `merge_conflict_rounds.expected_signals`, the check and status names (at most 200, each 1 to 255 characters with no control character) a paired item's public pull request showed before the round republished it, and restates the guard function so a recorded value cannot change.

`1017_sitekit_role_routing.sql` (#925) inserts six `routing_rows` for the site kit's `site-extractor` and `site-verifier` roles, one per size, into every `routing_tables` version whose status is `live` or `proposed`, leaving existing rows alone, and widens the `role_settings_model_floor` check so it names `site-verifier` beside the two security roles. Both steps are skipped where the table or constraint does not exist yet. `1018_run_checks_reason_no_change.sql` (#926) adds `no_change` to the values the `run_checks.reason` check accepts, matching the runner protocol's `CHECK_NOT_RUN_REASONS`.

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

Migrations are written to apply as the database's non-superuser owning role on hosted Postgres (Neon), not only on the superuser-owned clusters local development and CI use — introduced in `#92`. Several migrations that transfer function ownership to `platform_ops` need `platform_ops` to briefly hold `CREATE` on schema `public`, a privilege only available to a `CREATEROLE` role (never a superuser-only grant) under a specific, self-bracketed sequence: grant, do the ownership transfer, revoke. The full owner shape and the per-file bracket rule this depends on are covered in the operator runbooks (not part of this public tree).

## Append-only evidence tables

Two tables exist to record what happened, not to be read back by application logic to decide what happens next:

- `ledger`: `app_user` holds only `SELECT, INSERT` on it (`0001_core.sql`) — no `UPDATE` or `DELETE` grant exists for any tenant-facing role, so a row, once written, cannot be edited or removed by the tenant that wrote it.
- `audit_log`: originally also writable by a plain `INSERT` grant, `#91` (`packages/db/migrations/0008_audit_log_append_only.sql`) revokes that grant from `app_user` outright and replaces it with two `SECURITY DEFINER` functions, `audit_write` and `audit_write_system`, both owned by `platform_ops`. `audit_write` is the only way `app_user` can still produce an `audit_log` row: it stamps `account_id` and `actor` from the caller's own session state (`app.account_id`, and `current_member_user_id()`) rather than trusting caller-supplied values, restricts `action` to a literal allowlist, and overwrites any caller-supplied `actor` key inside the payload. `audit_write_system` is the platform-only equivalent for a system/webhook actor.

## Tables with no application code at HEAD

None at this HEAD for `idempotency_keys`: `packages/api/src/idempotency.ts` (`#130`) now implements the read/write protocol the `0600_api_core.sql` migration's header anticipated.

The five machine tables of `1035_machine_tables.sql` have no reader or writer in application code at HEAD. The only code that touches them is the reconciler's `packages/reconcile/src/jobs/machinePrune.ts`, which calls the three prune functions.

Of the tables of `1036_onboarding_tables.sql`, only `runner_device_codes` has application code behind it: `packages/runner-cloud/src/deviceFlow.ts` calls the six definers of `1037`, and the reconciler's `onboardingPrune.ts` calls the two prune functions, one of which deletes from `project_drafts`. `onboarding_tracks`, `project_setups`, `project_drafts` and `engine_releases` are read and written by no source file at HEAD; only their tests touch them.
