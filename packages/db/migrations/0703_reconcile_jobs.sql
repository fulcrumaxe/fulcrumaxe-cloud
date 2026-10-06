-- The reconciler framework's job table (one row per job, seeded here).
--
-- One cron tick (apps/web/app/api/cron/reconcile) takes the jobs that are due, one at a time, in a fixed order. A job
-- runs only after one atomic UPDATE has given this tick its lease: the row must be due, and its lease must be empty or
-- already expired. A lease is a pair of columns on the row, not an advisory lock: advisory locks belong to a session or
-- a transaction and do not survive a pooled connection between statements.
--
-- Platform-wide, like rate_limit_windows (0622): no account_id, FORCE row level security with a policy for platform_ops
-- only, and no grant at all for app_user. The cron connects as platform_ops. Customers never read or write it.
--
-- last_full_pass_at is the lap-time clock: set only when a job's cursor wrapped (it covered its whole estate). Lap time
-- is now() minus that. created_at stands in for it until the first full pass, so a job that never completes still
-- breaches the "twice the interval" rule instead of looking healthy forever.
CREATE TABLE reconcile_jobs (
  name              text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,28}$'),
  interval_seconds  integer NOT NULL CHECK (interval_seconds > 0),
  next_due_at       timestamptz NOT NULL DEFAULT now(),
  -- Opaque resume point of a job that stopped on a budget. Never customer data: a job stores a position, not a name.
  cursor            text CHECK (cursor IS NULL OR length(cursor) <= 200),
  -- A short code ("ok", "budget", "error", "disabled", ...), never free text, so nothing upstream can reach this column.
  last_result_code  text CHECK (last_result_code IS NULL OR last_result_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  last_ok_at        timestamptz,
  last_full_pass_at timestamptz,
  lease_owner       text CHECK (lease_owner IS NULL OR length(lease_owner) <= 80),
  lease_expires_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconcile_jobs_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

ALTER TABLE reconcile_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_full_access ON reconcile_jobs TO platform_ops
  USING (true) WITH CHECK (true);
-- No INSERT or DELETE: a job exists because a migration seeded it.
GRANT SELECT, UPDATE ON reconcile_jobs TO platform_ops;

-- The first job: prune error_events (the table 0702 creates) after 30 days, daily.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('error_events_prune', 86400);

-- The prune job runs as platform_ops and deletes old rows from error_events (0702), choosing them by last_seen_at.
-- 0702 leaves pruning to this task, which therefore takes its own grant.
GRANT SELECT, DELETE ON error_events TO platform_ops;
