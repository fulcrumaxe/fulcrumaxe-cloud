-- D#2 H13e: the run resolver reads installations.app_kind so the mint can pick
-- the App credentials by kind and refuse every kind but 'team' for a run
-- (D#31 C23 rulings 1 and 4). 0613 and 0619 granted platform_ops only
-- (id, account_id, gh_installation_id) on installations; this adds the one
-- column the resolver now reads and nothing else.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket
-- is copied from 0647.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT SELECT (app_kind) ON installations TO platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
