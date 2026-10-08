-- A recorded hold for the reconcilers' detach breaker (D#454 H2b2). When the installation job refuses a mass detach for
-- one App kind, it writes the held installation ids here, once per distinct set, and the owner releases the hold by hand.
-- Nothing releases it on its own: the failure the breaker exists for (a wrong or rotated App key) repeats on every run.
--
-- Only numeric GitHub installation ids and the App kind are stored: no names, no account ids, nothing GitHub sends as
-- free text. The one free-text column, released_note, is typed by the owner and capped at 200 characters.
--
-- One OPEN hold (consumed_at IS NULL) per job and kind; a different id set replaces it in place. A release lapses 48 hours
-- after released_at if no run consumed it (the job and the launch check apply that rule; the row is not rewritten).
--
-- platform_ops only, like reconcile_jobs (0703): RLS is forced and app_user gets nothing. The job (cron) and the owner
-- release route both connect as platform_ops. The privilege bracket is copied from 0667.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE reconcile_breaker_holds (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job                 text NOT NULL CHECK (job ~ '^[a-z][a-z0-9_]{0,28}$'),
  app_kind            text NOT NULL CHECK (app_kind IN ('team', 'team_readonly', 'sitekit')),
  gh_installation_ids bigint[] NOT NULL CHECK (cardinality(gh_installation_ids) BETWEEN 1 AND 5000),
  first_tripped_at    timestamptz NOT NULL DEFAULT now(),
  last_tripped_at     timestamptz NOT NULL DEFAULT now(),
  trip_count          integer NOT NULL DEFAULT 1 CHECK (trip_count >= 1),
  released_at         timestamptz,
  released_note       text CHECK (released_note IS NULL OR length(released_note) <= 200),
  consumed_at         timestamptz
);

CREATE UNIQUE INDEX reconcile_breaker_holds_one_open ON reconcile_breaker_holds (job, app_kind) WHERE consumed_at IS NULL;

ALTER TABLE reconcile_breaker_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcile_breaker_holds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON reconcile_breaker_holds FROM PUBLIC;
CREATE POLICY platform_ops_all ON reconcile_breaker_holds FOR ALL TO platform_ops USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON reconcile_breaker_holds TO platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
