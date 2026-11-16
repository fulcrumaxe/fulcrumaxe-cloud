-- D#483 S5-j2e-RUNNER: a round remembers the CI signals its public pull request showed BEFORE the round republished it.
--
-- A paired `runner_local` item's merge gate reads CI on the public pull request. When a round ends, the gate is asked again and must see every signal the item showed before the round.
-- The runner's fence answers for the pull request's LAST commit only, so once the round has republished, the pre-round head can no longer be read: the names have to be taken while
-- that head is still the live public head, at the start of the round, and kept with the round. `expected_signals` holds them: the check and status names (no content), written by the
-- INSERT that starts the round and never changed (not in the UPDATE grant, and the guard refuses a change). NULL means nothing was recorded (an unpaired item, a read that failed or
-- returned no signal, a later round of a chain): the gate then never reads that item's CI as green.
--
-- Expand-only: one nullable column, one CHECK function, the guard restated with one more clause. Must merge after the migration numbered 1022 (D#483 S5-j2e-RUNNER, the PR before this one in the order).

-- A list of check and status names: at most 200 of them, each 1 to 255 characters with no control character, no empty name and no null.
CREATE FUNCTION merge_conflict_signals_ok(p_names text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_names IS NOT NULL AND array_ndims(p_names) = 1 AND cardinality(p_names) BETWEEN 1 AND 200
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_names) AS n(name)
        WHERE n.name IS NULL OR char_length(n.name) NOT BETWEEN 1 AND 255 OR n.name ~ '[[:cntrl:]]' OR n.name ~ ('[' || chr(133) || chr(8232) || chr(8233) || ']')
     )
$$;
REVOKE ALL ON FUNCTION merge_conflict_signals_ok(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_conflict_signals_ok(text[]) TO app_user;

ALTER TABLE merge_conflict_rounds
  ADD COLUMN expected_signals text[]
  CONSTRAINT merge_conflict_rounds_expected_signals_check CHECK (expected_signals IS NULL OR merge_conflict_signals_ok(expected_signals));

-- 0948's guard, whole, with one more recorded fact: the expected signals are written by the INSERT and never change (a set value stays, and a NULL stays NULL).
CREATE OR REPLACE FUNCTION merge_conflict_rounds_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.outcome IS NOT NULL THEN NEW.ended_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
     OR (OLD.to_sha IS NOT NULL AND NEW.to_sha IS DISTINCT FROM OLD.to_sha)
     OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.ended_at IS DISTINCT FROM OLD.ended_at))
     OR NEW.expected_signals IS DISTINCT FROM OLD.expected_signals THEN
    RAISE EXCEPTION 'merge_conflict_rounds: a recorded fact is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome IS NULL AND NEW.outcome IS NOT NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END;
$$;
