-- DP6a (D#7 C22 B1, C23): the time up to which a decision is free to reverse, stamped when its receipt is written.
--
-- It records the promise made at that moment as an absolute UTC time, so a later change to the catalogue's window never moves a promise
-- already made. NULL means no promise was recorded: the entry cannot be reversed, or the receipt came from a writer that does not stamp one.
--
-- How it is written: the receipt writer (packages/db/src/receiptWriter.ts) sets the transaction-local setting app.reversal_window_hours
-- from the catalogue entry just before it calls the definer, and this BEFORE INSERT trigger turns it into created_at + that many hours.
-- No definer's signature changes, so none of their grants or owners are touched. The column is in no definer's insert list and no role
-- holds UPDATE on the table, so a row's stamp can only be set at insert time and only through the setting. A caller who sets the setting
-- by hand can only move the deadline on a receipt that the receipt login's own definer is writing for its own tenant.
-- The trigger function is an invoker, owned by the migration owner (trigger-function-ownership.pg.test.ts).
-- Expand-only: one nullable column, one check, one function and one trigger.

ALTER TABLE decision_receipts
  ADD COLUMN reversal_free_until timestamptz,
  ADD CONSTRAINT decision_receipts_reversal_free_until_check
    CHECK (reversal_free_until IS NULL OR reversal_free_until > created_at);

CREATE FUNCTION decision_receipts_stamp_reversal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_hours text := NULLIF(current_setting('app.reversal_window_hours', true), '');
BEGIN
  IF NEW.reversal_free_until IS NULL AND v_hours IS NOT NULL AND v_hours ~ '^[0-9]{1,4}$' AND v_hours::integer BETWEEN 1 AND 8760 THEN
    NEW.reversal_free_until := NEW.created_at + make_interval(hours => v_hours::integer);
  END IF;
  -- One-shot: the setting is spent by the row it was set for, so a receipt another definer writes later in the same transaction gets no stamp.
  IF v_hours IS NOT NULL THEN
    PERFORM set_config('app.reversal_window_hours', '', true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER decision_receipts_stamp_reversal
  BEFORE INSERT ON decision_receipts
  FOR EACH ROW EXECUTE FUNCTION decision_receipts_stamp_reversal();
