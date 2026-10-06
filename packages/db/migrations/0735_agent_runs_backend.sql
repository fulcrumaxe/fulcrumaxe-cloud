-- D#221 R1b: which agent backend a run used. The runner resolves the backend once, when the run is admitted, and a resume
-- must find the same one on the run it continues (it fails closed on a missing or different backend, as it does for a
-- model outside the price table).
--
-- Shape. NOT NULL with the default 'claude-code': every run that exists today, and every run inserted by agent_run_create
-- (which does not name the column), is a Claude Code run, and that is a true statement about them rather than a guess.
-- The CHECK is the same shape rule the registry applies to a backend's name (lower case, short, no punctuation a shell
-- could read), so a stored value is always safe to print and to pass on as a name. It does not say which backends exist:
-- selectability is the runner's registry, and a name the registry does not know is refused at admit.
--
-- Immutable. The value is fixed when the row is inserted; no later statement may change it, from any role (a trigger, so
-- it also binds the table owner). Nothing grants UPDATE on the column to app_user or platform_ops either. A second
-- backend needs a way to stamp a non-default name at creation; that belongs to the change that makes one selectable
-- (D#221 R2), together with the definer that writes it. Until then every inserted run carries the default.
ALTER TABLE agent_runs
  ADD COLUMN backend text NOT NULL DEFAULT 'claude-code';

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_backend_name_check CHECK (backend ~ '^[a-z][a-z0-9-]{0,31}$');

CREATE FUNCTION agent_runs_backend_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.backend IS DISTINCT FROM OLD.backend THEN
    RAISE EXCEPTION 'agent_runs.backend is immutable after insert (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_backend_immutable
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_backend_immutable();
