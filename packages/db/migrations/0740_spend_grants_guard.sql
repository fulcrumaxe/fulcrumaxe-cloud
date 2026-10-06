-- D#2 SPEND-GRANTS: a plain tenant login can no longer settle or release its own compute or preview
-- reservation, and can no longer write a compute ledger row.
--
-- The gap: app_user holds UPDATE on spend_reservations (0001) and INSERT on ledger (0001). RLS pins the
-- tenant, not the row, so a tenant could flip its own open compute or preview reservation to released
-- (freeing its cap), or pre-insert a ledger row on a compute budget (the 0629 unique key then makes the
-- real compute settle fail, and the preview cap reads the fake usd).
--
-- Why triggers and not REVOKE: the runner login only holds these privileges through app_user, so a
-- REVOKE would take them from the runner as well; it would also turn the model-row paths red (model rows
-- stay with app_user on purpose); and the rule depends on the row (compute or preview only), which a
-- grant cannot say. A BEFORE trigger binds every role, as the 0002/0003 guards do.
--
-- Who may pass: a session whose LOGIN (session_user, never current_user or a setting a caller can
-- change) is a usable member of agent_run_writer, or who is a superuser or the table's owner (migrations
-- and test seeding). The same predicate is written out in both functions rather than shared through a
-- helper: a new PUBLIC-executable function would widen what every login can call (0696 pins that list).
-- The functions are plain INVOKER with a pinned search_path, owned by the migration
-- role. Nothing here changes a GRANT; rollback is dropping the two triggers and two functions.

CREATE FUNCTION spend_reservations_guard_compute_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.state = 'open'
     AND NEW.state IS DISTINCT FROM OLD.state
     AND (OLD.budget IN ('foreground_compute', 'background_compute') OR OLD.purpose = 'preview')
     AND NOT (pg_has_role(session_user, 'agent_run_writer', 'USAGE')
          OR pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'USAGE'))
  THEN
    RAISE EXCEPTION 'spend_reservations: only the runner may settle or release a compute or preview reservation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spend_reservations_guard_compute_state
  BEFORE UPDATE OF state ON spend_reservations
  FOR EACH ROW
  EXECUTE FUNCTION spend_reservations_guard_compute_state();

CREATE FUNCTION ledger_guard_compute_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- No CHECK ties kind to budget, so the budget and compute_basis clauses are what stop a kind='model'
  -- row from squatting on a run's compute budget.
  IF (NEW.kind = 'compute'
      OR NEW.budget IN ('foreground_compute', 'background_compute')
      OR NEW.compute_basis IS NOT NULL)
     AND NOT (pg_has_role(session_user, 'agent_run_writer', 'USAGE')
          OR pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'USAGE'))
  THEN
    RAISE EXCEPTION 'ledger: only the runner may write a compute ledger row'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_guard_compute_insert
  BEFORE INSERT ON ledger
  FOR EACH ROW
  EXECUTE FUNCTION ledger_guard_compute_insert();
