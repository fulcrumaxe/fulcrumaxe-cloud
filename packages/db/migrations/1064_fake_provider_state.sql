-- D#845 MC-13a: the state of the staging fake provider (the Hetzner fake served at /api/_fake/hetzner). One row per provider, one JSON document.
-- platform_ops only, like cron_last_tick (0926): RLS is forced and app_user and every tenant role get nothing, so no tenant session can read or write it.
-- The privilege bracket is copied from 0926.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE fake_provider_state (
  provider   text PRIMARY KEY CHECK (provider IN ('hetzner')),
  state      jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object' AND pg_column_size(state) < 4194304),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fake_provider_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE fake_provider_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fake_provider_state FROM PUBLIC;
CREATE POLICY platform_ops_all ON fake_provider_state FOR ALL TO platform_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON fake_provider_state TO platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
