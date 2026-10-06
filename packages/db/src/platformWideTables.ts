/**
 * Table names that are platform-wide rather than per-tenant, and are
 * therefore exempt from the "every table has RLS" check in rlsInventory.ts.
 *
 * H02 (this package) does not add anything here: every table it owns has
 * `account_id` and full row-level security. This list exists as a named,
 * explicit place for a later task to add its own platform-wide tables
 * without touching the inventory-check logic itself -- per the D#2605 Spec
 * amendment, H22's model-routing table and its versions table are
 * platform-wide and will be added here when H22 lands, not created by H02.
 *
 * H22 (migrations/0010_model_routing.sql): routing_tables and routing_rows
 * hold the routing table versions and their (role, size) -> model rows.
 * Every account reads the same live version, so there is no account_id to
 * scope a tenant policy on.
 *
 * D#8 R1 (migrations/0611_exposure_audit.sql): platform_audit is the
 * append-only, cross-tenant audit trail for platform-wide actions --
 * audit_log.account_id is NOT NULL, so a platform-wide action (the
 * emergency floor path, a cross-account admin decision) has no legal row
 * shape there. platform_audit's account_id is nullable by design, and the
 * table carries no RLS at all (same as routing_tables/routing_rows above),
 * so it is exempted here rather than given a policy that would just be
 * USING (true) for every role that can reach it anyway.
 *
 * D#454 H1a (migrations/0702_error_events.sql): error_events holds counted error CLASSES (hour, service, route
 * template, stage, code) with no account or user column at all, written only through the error_event_record()
 * definer, so it has no tenant to scope a policy on and carries no RLS.
 */
export const PLATFORM_WIDE_TABLES: readonly string[] = ['routing_tables', 'routing_rows', 'platform_audit', 'error_events'];
