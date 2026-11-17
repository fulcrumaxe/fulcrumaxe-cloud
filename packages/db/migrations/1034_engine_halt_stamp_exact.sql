-- Engine bridge EB-11a hardening: a tenant session gets the exact current epoch stamped on a command, never a value it chose.
--
-- 1031's trigger raised the caller's stamp to the current epoch but kept the higher of the two (GREATEST). Nothing reaches that today (the one
-- inserter stamps an epoch it read on the server), but a stamp above the current epoch would make a command look newer than any halt so far, and
-- a later insert path that passes a caller-chosen number would inherit it. So:
--   * any session that names a tenant (app.account_id set, which is every person's and every runner's session) is stamped with exactly the
--     epoch engine_halt_epoch answers, whatever it passed in;
--   * a session with no tenant (the migration owner's connection, which is how fixtures insert rows) keeps GREATEST, so a fixture can still
--     stamp a command ahead of the marker.
-- Everything else is 1031's body unchanged: the share lock for every kind, the refusal of start-like commands while halted, invoker rights and
-- the pinned search_path. CREATE OR REPLACE keeps the function's owner, its privileges and the trigger that calls it.

CREATE OR REPLACE FUNCTION engine_commands_refuse_halted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_halted boolean := public.engine_halt_lock(NEW.account_id, NEW.repo_id);
BEGIN
  -- The lock is taken for every kind, so the epoch below cannot move before this insert commits. It is read in its own statement
  -- (a fresh snapshot after the lock wait): a halt and a clear that commit between the route's own read and this insert still give the command
  -- the current epoch.
  IF NULLIF(current_setting('app.account_id', true), '') IS NULL THEN
    NEW.halt_epoch_at_issue := GREATEST(COALESCE(NEW.halt_epoch_at_issue, 0), public.engine_halt_epoch(NEW.account_id, NEW.repo_id));
  ELSE
    NEW.halt_epoch_at_issue := public.engine_halt_epoch(NEW.account_id, NEW.repo_id);
  END IF;
  -- pause_loop, answer_ask and stop_agent are the ways a person quiets or answers a halted engine: they stay allowed.
  IF NEW.kind IN ('start_day', 'resume_loop', 'request_spawn', 'set_dial') AND v_halted IS TRUE THEN
    RAISE EXCEPTION 'engine_halted' USING ERRCODE = 'HX409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION engine_commands_refuse_halted() FROM PUBLIC;
