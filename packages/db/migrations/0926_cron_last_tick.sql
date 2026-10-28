-- CRON-OBS-1: when each cron sweep last connected to the database. A cron tick that ends at the no-database gate writes nothing here
-- (its tick time lives in Runtime Cache); a tick that connects anyway, because of a marker or the backstop, upserts its row through its own
-- platform_ops pool (one extra connection per instance, opened on the first connecting tick, never by a skipped one). The operator view of /api/health reads these rows, so a deployment whose crons stopped, or whose cache lost the ticks,
-- can still be told from one that is simply idle.
--
-- One row per sweep name (a fixed code, no tenant, no free text). platform_ops only, like reconcile_jobs (0703): RLS is forced and app_user
-- gets nothing. The privilege bracket is copied from 0667 and 0748.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE cron_last_tick (
  sweep             text PRIMARY KEY CHECK (sweep ~ '^[a-z][a-z0-9-]{0,40}$'),
  last_tick_at      timestamptz NOT NULL,
  last_connected_at timestamptz NOT NULL
);

ALTER TABLE cron_last_tick ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_last_tick FORCE ROW LEVEL SECURITY;
REVOKE ALL ON cron_last_tick FROM PUBLIC;
CREATE POLICY platform_ops_all ON cron_last_tick FOR ALL TO platform_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON cron_last_tick TO platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
