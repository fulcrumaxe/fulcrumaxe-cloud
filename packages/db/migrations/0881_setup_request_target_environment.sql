-- D#598 P8d-1: the Vercel environment an env-var setup request is checked against.
--
-- An env_var request names a variable on a project; which of the project's environments (production, preview, development) must hold it is
-- the proposer's choice, production when they say nothing. The automatic check and the sentence "{name} is set on {project}, but not for
-- {environment}" both read this one column, so they cannot name different environments.
--
-- Stamped at insert like the request's other terms (env_name, check_kind): the freeze trigger lists it, so no role can change it afterwards.
-- app_user already holds table-level INSERT and SELECT; UPDATE stays column-granted and does not include it. Every row has a value (the
-- default is a constant, so existing rows read production without a rewrite); it only means something on an env_var request, and the API
-- shows null for every other kind.
--
-- One open request per step now includes the environment: asking for the same variable in preview while the production request is open is
-- a different step, not a repeat. The new unique index is created before the old one is dropped, so there is no moment without one.
--
-- Expand-only for data; the old unique index is replaced by a strictly wider-keyed one (every row the old one allowed, the new one allows).
-- Numbered above the highest migration on the code plane and the open PRs' claims (0877 and 0880 are claimed); re-checked right before opening.

ALTER TABLE setup_requests
  ADD COLUMN target_environment text NOT NULL DEFAULT 'production'
  CONSTRAINT setup_requests_target_environment_check CHECK (target_environment IN ('production', 'preview', 'development'));

CREATE UNIQUE INDEX uq_setup_requests_open_env ON setup_requests
  (account_id, repo_id, kind, target, COALESCE(env_name, ''), target_environment, COALESCE(work_item_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'open';
DROP INDEX uq_setup_requests_open;

CREATE OR REPLACE FUNCTION setup_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.repo_id, NEW.work_item_id, NEW.origin, NEW.kind, NEW.env_name, NEW.target_environment, NEW.provider_url, NEW.check_kind, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.repo_id, OLD.work_item_id, OLD.origin, OLD.kind, OLD.env_name, OLD.target_environment, OLD.provider_url, OLD.check_kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'setup_requests_frozen: a request''s identity and stamped terms cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'withdrawn' THEN
    RAISE EXCEPTION 'setup_requests_terminal: a withdrawn request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.target, NEW.reason) IS DISTINCT FROM (OLD.target, OLD.reason)
     AND NOT (OLD.origin = 'derived' AND OLD.state = 'open' AND NEW.state = 'open') THEN
    RAISE EXCEPTION 'setup_requests_frozen: only an open derived request may be refreshed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'open' AND NEW.state IN ('done', 'withdrawn'))
         OR (OLD.state = 'done' AND NEW.state = 'open' AND OLD.check_kind IS NOT NULL AND NEW.check_reason IS NOT NULL)) THEN
      RAISE EXCEPTION 'setup_requests_illegal_transition: % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'open' THEN
      NEW.resolved_at := now();
    END IF;
  ELSIF (NEW.resolution, NEW.resolved_by, NEW.resolved_at) IS DISTINCT FROM (OLD.resolution, OLD.resolved_by, OLD.resolved_at) THEN
    RAISE EXCEPTION 'setup_requests_frozen: a resolution cannot change without a transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
