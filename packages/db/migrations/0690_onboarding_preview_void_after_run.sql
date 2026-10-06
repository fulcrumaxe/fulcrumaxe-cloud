-- D#2 H17c-2c: a preview whose run was refused at admit may be voided.
--
-- 0685's shape CHECK allowed 'void' only without a run, and its write guard
-- allowed only requested -> running | void. So a run refused at admit (nothing
-- spent) stayed linked and used up the customer's one live preview, although
-- the intent (a void preview spent nothing and frees the slot) says otherwise.
--
-- Two changes, nothing else:
--   * the shape CHECK lets 'void' carry run_id and started_at (they travel
--     together, as for running and finished);
--   * the write guard lets running -> void, and only that: the run link, the
--     start time and every identity column stay as they were.
-- The partial unique indexes already exclude 'void', so the slot is freed.
-- The guard function keeps its owner, its grants, its search_path and its
-- trigger; the table's grants, policies and RLS are untouched.

ALTER TABLE onboarding_previews DROP CONSTRAINT onboarding_previews_shape;
ALTER TABLE onboarding_previews ADD CONSTRAINT onboarding_previews_shape CHECK (
  (state = 'requested' AND run_id IS NULL AND started_at IS NULL AND void_reason IS NULL)
  OR (state IN ('running', 'finished') AND run_id IS NOT NULL AND started_at IS NOT NULL AND void_reason IS NULL)
  OR (state = 'void' AND (run_id IS NULL) = (started_at IS NULL) AND void_reason IS NOT NULL));

CREATE OR REPLACE FUNCTION onboarding_previews_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'onboarding_previews: platform_ops may not write directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'requested' THEN
      RAISE EXCEPTION 'onboarding_previews: a preview is inserted as requested' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.id, NEW.account_id, NEW.installation_id, NEW.repo_id, NEW.gh_user_id, NEW.model_cap_usd, NEW.compute_cap_usd, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.installation_id, OLD.repo_id, OLD.gh_user_id, OLD.model_cap_usd, OLD.compute_cap_usd, OLD.created_at)
     OR NOT ((OLD.state = 'requested' AND NEW.state IN ('requested', 'running', 'void')
              AND (NEW.run_action_id = OLD.run_action_id OR NEW.state = 'requested'))
             -- running -> void keeps the run link, the start time and the action exactly as they were.
             OR (OLD.state = 'running' AND NEW.state = 'void'
                 AND (NEW.run_id, NEW.started_at, NEW.run_action_id) IS NOT DISTINCT FROM (OLD.run_id, OLD.started_at, OLD.run_action_id))) THEN
    RAISE EXCEPTION 'onboarding_previews: illegal change from %', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
