-- D#2 PREVIEW-PER-INSTALL-LIMIT: a GitHub installation and a GitHub owner get one free preview per rolling
-- window, counted across ALL accounts, so a fresh fulcrumaxe account over the same GitHub org (or a re-install
-- of the App, which gets a new GitHub installation id) cannot repeat the free compute.
--
-- 0685's two unique indexes key on the GitHub installer and on the ACCOUNT-LOCAL installations.id; neither sees
-- the same org or user coming back through a new account. This adds:
--   * two identity columns on onboarding_previews, copied by the request definer from the repo it already
--     resolves (never from the caller): gh_installation_id (GitHub's id) and gh_owner (lower-cased login).
--     Existing rows are backfilled from installations/repos; if one cannot be, SET NOT NULL fails and the
--     migration stops (nothing is deleted or guessed). The write guard holds both fixed after insert.
--   * two partial indexes that serve the window counts.
--   * onboarding_preview_request, same signature/owner/grants: after the idempotent-replay branch and before
--     the INSERT it takes transaction-scoped advisory locks (installation, then owner, always in that order),
--     counts non-void previews in the window for each key across accounts, and raises SQLSTATE PX409 when
--     either count has reached the limit. A repo with no gh_owner is "repo not found" (P0002): fail closed.
--     The limit and the window are the two constants in the function (core mirrors them; a test keeps them equal).
--   * for that cross-account count the owner (platform_ops) gains SELECT on three columns and a row policy
--     showing it non-void rows to any session but a direct platform_ops login (0685/0691 shape), so a direct
--     login still reads no unstarted row. No tenant role gains a privilege (app_user's table-wide SELECT, which
--     extends to the new columns, stays limited to its own tenant's rows by RLS).
-- Privilege brackets as in 0685.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE onboarding_previews ADD COLUMN gh_installation_id bigint, ADD COLUMN gh_owner text;

-- The write guard holds every other column fixed, so the backfill steps around it (restored right after).
ALTER TABLE onboarding_previews DISABLE TRIGGER onboarding_previews_write_guard;
-- Dynamic, and only when rows exist: a row can only exist after 0619 added repos.gh_owner, and a test replays
-- the chain without 0619, where this statement could not even be parsed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM onboarding_previews) THEN
    EXECUTE 'UPDATE onboarding_previews p
                SET gh_installation_id = i.gh_installation_id, gh_owner = lower(r.gh_owner)
               FROM installations i, repos r
              WHERE i.account_id = p.account_id AND i.id = p.installation_id
                AND r.account_id = p.account_id AND r.id = p.repo_id';
  END IF;
END
$$;
ALTER TABLE onboarding_previews ENABLE TRIGGER onboarding_previews_write_guard;

ALTER TABLE onboarding_previews
  ALTER COLUMN gh_installation_id SET NOT NULL,
  ALTER COLUMN gh_owner SET NOT NULL,
  ADD CONSTRAINT onboarding_previews_gh_installation_id_check CHECK (gh_installation_id > 0),
  ADD CONSTRAINT onboarding_previews_gh_owner_check CHECK (gh_owner = lower(gh_owner) AND gh_owner <> '');

CREATE INDEX onboarding_previews_install_window ON onboarding_previews (gh_installation_id, created_at) WHERE state <> 'void';
CREATE INDEX onboarding_previews_owner_window ON onboarding_previews (gh_owner, created_at) WHERE state <> 'void';

GRANT SELECT (created_at, gh_installation_id, gh_owner) ON onboarding_previews TO platform_ops;
GRANT INSERT (gh_installation_id, gh_owner) ON onboarding_previews TO platform_ops;
CREATE POLICY platform_ops_read_window ON onboarding_previews FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND state <> 'void');

-- 0690's guard with the two new columns added to the identity tuple.
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
  ELSIF (NEW.id, NEW.account_id, NEW.installation_id, NEW.repo_id, NEW.gh_user_id, NEW.gh_installation_id, NEW.gh_owner, NEW.model_cap_usd, NEW.compute_cap_usd, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.installation_id, OLD.repo_id, OLD.gh_user_id, OLD.gh_installation_id, OLD.gh_owner, OLD.model_cap_usd, OLD.compute_cap_usd, OLD.created_at)
     OR NOT ((OLD.state = 'requested' AND NEW.state IN ('requested', 'running', 'void')
              AND (NEW.run_action_id = OLD.run_action_id OR NEW.state = 'requested'))
             -- running -> void keeps the run link, the start time and the action exactly as they were.
             OR (OLD.state = 'running' AND NEW.state = 'void'
                 AND (NEW.run_id, NEW.started_at, NEW.run_action_id) IS NOT DISTINCT FROM (OLD.run_id, OLD.started_at, OLD.run_action_id))) THEN
    RAISE EXCEPTION 'onboarding_previews: illegal change from %', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- 0685's request definer with the limit added (marked LIMIT below). Owner, grants and search_path unchanged.
CREATE OR REPLACE FUNCTION onboarding_preview_request(p_repo_id uuid, p_idempotency_key text, p_request_hash text)
RETURNS TABLE (preview_id uuid, action_id uuid, state text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  -- LIMIT: free previews per GitHub installation and per owner in the window (core mirrors both).
  c_limit   CONSTANT int := 1;
  c_window  CONSTANT interval := interval '30 days';
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid := current_member_user_id();
  pid       uuid;
  inst      uuid;
  gh_inst   bigint;
  own       text;
  installer bigint;
  ra        record;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'onboarding_preview_request: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(current_setting('app.token_id', true), '') IS NOT NULL OR usr IS NULL
     OR COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'onboarding_preview_request: a session owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL THEN
    RAISE EXCEPTION 'onboarding_preview_request: repo is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT p.id INTO pid FROM public.onboarding_previews p
      JOIN public.run_action_requests q ON q.id = p.run_action_id AND q.account_id = p.account_id
     WHERE p.account_id = acct AND q.requested_by = 'session:' || usr::text AND q.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT * INTO ra FROM public.run_action_request('start_preview', pid, p_idempotency_key, p_request_hash);
      RETURN QUERY SELECT pid, ra.action_id, ra.state, true;
      RETURN;
    END IF;
  END IF;

  SELECT r.installation_id, i.gh_installation_id, lower(r.gh_owner) INTO inst, gh_inst, own
    FROM public.repos r JOIN public.installations i ON i.account_id = r.account_id AND i.id = r.installation_id
   WHERE r.id = p_repo_id AND r.account_id = acct AND i.app_kind = 'team_readonly';
  -- LIMIT: a repo with no recorded owner cannot be counted, so it is refused (fail closed).
  IF NOT FOUND OR own IS NULL THEN
    RAISE EXCEPTION 'onboarding_preview_request: repo not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT ii.installer_gh_user_id INTO installer FROM public.installation_installers ii
   WHERE ii.gh_installation_id = gh_inst AND ii.app_kind = 'team_readonly'
     AND ii.deleted_at IS NULL AND ii.suspended_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding_preview_request: repo not found' USING ERRCODE = 'P0002';
  END IF;

  -- LIMIT: serialise requests for the same installation, then the same owner (always in this order), until
  -- commit, so the counts below see every earlier committed preview and two requests cannot both pass.
  PERFORM pg_advisory_xact_lock(hashtextextended('onboarding_preview:installation:' || gh_inst::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('onboarding_preview:owner:' || own, 0));
  -- This account's own live preview on this installation is 0685's older refusal (the INSERT below raises
  -- 23505, API preview_exists), so it keeps answering first and the limit stands aside. The count columns are
  -- all the owner may read; the installer column is not among them.
  IF NOT EXISTS (SELECT 1 FROM public.onboarding_previews p
                  WHERE p.account_id = acct AND p.gh_installation_id = gh_inst AND p.state <> 'void')
     AND ((SELECT count(*) FROM public.onboarding_previews p
            WHERE p.gh_installation_id = gh_inst AND p.state <> 'void' AND p.created_at > now() - c_window) >= c_limit
          OR (SELECT count(*) FROM public.onboarding_previews p
               WHERE p.gh_owner = own AND p.state <> 'void' AND p.created_at > now() - c_window) >= c_limit) THEN
    RAISE EXCEPTION 'onboarding_preview_request: a preview was already used for this GitHub account recently' USING ERRCODE = 'PX409';
  END IF;

  -- run_action_id is a placeholder until the action exists (it needs this row as its target).
  INSERT INTO public.onboarding_previews (account_id, installation_id, repo_id, gh_user_id, gh_installation_id, gh_owner, run_action_id)
  VALUES (acct, inst, p_repo_id, installer, gh_inst, own, gen_random_uuid()) RETURNING id INTO pid;
  SELECT * INTO ra FROM public.run_action_request('start_preview', pid, p_idempotency_key, p_request_hash);
  IF ra.replayed THEN
    RAISE EXCEPTION 'onboarding_preview_request: idempotency key already names another action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.onboarding_previews p SET run_action_id = ra.action_id WHERE p.id = pid;
  RETURN QUERY SELECT pid, ra.action_id, ra.state, false;
END $$;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
