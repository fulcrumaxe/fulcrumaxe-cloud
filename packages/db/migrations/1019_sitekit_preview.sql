-- D#3 K10: the site kit's read-only, one-time preview, with a daily compute counter of its own.
--
-- 1. spend_reservations.purpose gains 'sitekit_preview'. The compute a site-kit preview reserves is counted by its own
--    function, sitekit_preview_daily_compute_usd(), so these previews can never use up the onboarding preview's daily allowance, and
--    onboarding's preview_daily_compute_usd() never sees them. platform_ops reads those rows through a policy of its own, the
--    same shape as 0685's (never a direct platform_ops login, compute rows only).
-- 2. sitekit_previews: one row per preview request, read by its own account (app_user SELECT only). Every write goes through
--    the three definers below. The result kept is only the counts and the homepage render the screen shows.
-- 3. sitekit_preview_stamps: the one-time stamp, one per GitHub user id and one per GitHub installation id. It has no foreign
--    key to anything, on purpose: uninstalling the App, deleting its installation row, or reinstalling it leaves the stamp
--    where it is, so a reinstall cannot buy another preview on our compute. Only a preview whose agent never started (it
--    spent nothing) hands its stamp back; a preview that started an agent and failed keeps it.
-- 4. sitekit_preview_request(site, confirmed cap): session owner or admin only; the confirmed cap must be exactly 20; the
--    site must sit on a live sitekit installation with an installer record; refuses at the daily limit of the new counter
--    (PX429) and for a used stamp (PX409); a cap that was not confirmed is PX422. sitekit_preview_start and
--    sitekit_preview_finish move the row requested -> running -> finished | failed, or requested | running -> void, and nothing else.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket is copied from 0685.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

-- ---- 1. the purpose and the counter ----------------------------------------------------------------------------------
ALTER TABLE spend_reservations DROP CONSTRAINT spend_reservations_purpose_check;
ALTER TABLE spend_reservations
  ADD CONSTRAINT spend_reservations_purpose_check CHECK (purpose IN ('run', 'preview', 'sitekit_preview'));

CREATE POLICY platform_ops_sitekit_preview_compute ON spend_reservations FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND purpose = 'sitekit_preview' AND budget IN ('foreground_compute', 'background_compute'));

-- Same counting rule as preview_daily_compute_usd() (0689): an open row counts what it reserved, a settled one counts its
-- ledger figure, a released one counts what it reserved.
CREATE FUNCTION sitekit_preview_daily_compute_usd() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(SUM(CASE WHEN s.state = 'open' THEN s.usd_reserved ELSE COALESCE(l.usd, s.usd_reserved) END), 0)
    FROM public.spend_reservations s
    LEFT JOIN public.ledger l ON l.account_id = s.account_id AND l.run_id = s.run_id AND l.budget = s.budget
   WHERE s.purpose = 'sitekit_preview' AND s.budget IN ('foreground_compute', 'background_compute')
     AND s.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$;

-- ---- 2 and 3. the tables ---------------------------------------------------------------------------------------------
CREATE TABLE sitekit_preview_stamps (
  gh_user_id         bigint NOT NULL UNIQUE CHECK (gh_user_id > 0),
  gh_installation_id bigint NOT NULL UNIQUE CHECK (gh_installation_id > 0),
  preview_id         uuid NOT NULL UNIQUE,
  stamped_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sitekit_previews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  site_id             uuid NOT NULL,
  state               text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'running', 'finished', 'failed', 'void')),
  model_cap_usd       numeric NOT NULL DEFAULT 20 CHECK (model_cap_usd = 20),
  compute_cap_usd     numeric NOT NULL DEFAULT 1 CHECK (compute_cap_usd = 1),
  claims_total        integer CHECK (claims_total >= 0),
  claims_unverifiable integer CHECK (claims_unverifiable >= 0),
  blockers            integer CHECK (blockers >= 0),
  homepage_html       text CHECK (char_length(homepage_html) <= 1000000),
  reason              text CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  FOREIGN KEY (account_id, site_id) REFERENCES sites (account_id, id) ON DELETE CASCADE,
  CONSTRAINT sitekit_previews_shape CHECK (
    (state = 'requested' AND started_at IS NULL AND finished_at IS NULL AND reason IS NULL AND claims_total IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND reason IS NULL AND claims_total IS NULL)
    OR (state = 'finished' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND reason IS NULL
        AND claims_total IS NOT NULL AND claims_unverifiable IS NOT NULL AND blockers IS NOT NULL AND claims_unverifiable <= claims_total)
    OR (state = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND reason IS NOT NULL AND claims_total IS NULL)
    OR (state = 'void' AND started_at IS NULL AND finished_at IS NOT NULL AND reason IS NOT NULL AND claims_total IS NULL))
);
CREATE INDEX sitekit_previews_account_site ON sitekit_previews (account_id, site_id, created_at DESC);

ALTER TABLE sitekit_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE sitekit_previews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sitekit_previews FROM PUBLIC, app_user;
GRANT SELECT ON sitekit_previews TO app_user;
CREATE POLICY tenant_isolation_select ON sitekit_previews FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

ALTER TABLE sitekit_preview_stamps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sitekit_preview_stamps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sitekit_preview_stamps FROM PUBLIC, app_user;

-- The definers below are owned by platform_ops. Each policy shows it nothing to a direct platform_ops login, and only the
-- calling tenant's rows otherwise; the stamp table has no tenant column, so its policy is the login rule alone.
GRANT SELECT, INSERT, UPDATE ON sitekit_previews TO platform_ops;
CREATE POLICY platform_ops_tenant ON sitekit_previews FOR ALL TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON sitekit_preview_stamps TO platform_ops;
CREATE POLICY platform_ops_definer ON sitekit_preview_stamps FOR ALL TO platform_ops
  USING (session_user <> 'platform_ops') WITH CHECK (session_user <> 'platform_ops');

-- The request reads the site's repo link and nothing else of the site.
GRANT SELECT (id, account_id, repo_id) ON sites TO platform_ops;
CREATE POLICY platform_ops_sitekit_preview_read ON sites FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- 4. the definers --------------------------------------------------------------------------------------------------
CREATE FUNCTION sitekit_preview_request(p_site_id uuid, p_confirm_cap_usd numeric)
RETURNS TABLE (preview_id uuid, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid := current_member_user_id();
  gh_inst   bigint;
  installer bigint;
  pid       uuid := gen_random_uuid();
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'sitekit_preview_request: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(current_setting('app.token_id', true), '') IS NOT NULL OR usr IS NULL
     OR COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'sitekit_preview_request: a session owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_site_id IS NULL THEN
    RAISE EXCEPTION 'sitekit_preview_request: site is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_confirm_cap_usd IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'sitekit_preview_request: the model cap was not confirmed' USING ERRCODE = 'PX422';
  END IF;
  SELECT i.gh_installation_id INTO gh_inst
    FROM public.sites s
    JOIN public.repos r ON r.account_id = s.account_id AND r.id = s.repo_id
    JOIN public.installations i ON i.account_id = r.account_id AND i.id = r.installation_id
   WHERE s.id = p_site_id AND s.account_id = acct AND i.app_kind = 'sitekit';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sitekit_preview_request: site not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT ii.installer_gh_user_id INTO installer FROM public.installation_installers ii
   WHERE ii.gh_installation_id = gh_inst AND ii.app_kind = 'sitekit' AND ii.deleted_at IS NULL AND ii.suspended_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sitekit_preview_request: site not found' USING ERRCODE = 'P0002';
  END IF;
  -- The stamp is checked before the counter, so a used preview reads as used even on a day the counter is full.
  IF EXISTS (SELECT 1 FROM public.sitekit_preview_stamps t WHERE t.gh_user_id = installer OR t.gh_installation_id = gh_inst) THEN
    RAISE EXCEPTION 'sitekit_preview_request: the preview was already used' USING ERRCODE = 'PX409';
  END IF;
  IF public.sitekit_preview_daily_compute_usd() >= 10 THEN
    RAISE EXCEPTION 'sitekit_preview_request: today''s preview compute is used up' USING ERRCODE = 'PX429';
  END IF;
  INSERT INTO public.sitekit_previews (id, account_id, site_id) VALUES (pid, acct, p_site_id);
  INSERT INTO public.sitekit_preview_stamps (gh_user_id, gh_installation_id, preview_id) VALUES (installer, gh_inst, pid);
  RETURN QUERY SELECT pid, 'requested'::text;
END $$;

CREATE FUNCTION sitekit_preview_start(p_preview_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'sitekit_preview_start: no account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.sitekit_previews p SET state = 'running', started_at = clock_timestamp()
   WHERE p.id = p_preview_id AND p.account_id = acct AND p.state = 'requested';
  RETURN FOUND;
END $$;

-- p_state is 'finished' (the counts and the render are given), 'failed' (an agent that started and did not finish: the stamp
-- stays) or 'void' (the agent never started, so nothing was spent: the stamp is handed back). The caller decides which,
-- from whether any agent was started.
CREATE FUNCTION sitekit_preview_finish(
  p_preview_id uuid, p_state text, p_reason text, p_claims_total integer, p_claims_unverifiable integer, p_blockers integer, p_homepage_html text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'sitekit_preview_finish: no account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_state = 'finished' THEN
    UPDATE public.sitekit_previews p
       SET state = 'finished', finished_at = clock_timestamp(), claims_total = p_claims_total,
           claims_unverifiable = p_claims_unverifiable, blockers = p_blockers, homepage_html = p_homepage_html
     WHERE p.id = p_preview_id AND p.account_id = acct AND p.state = 'running';
  ELSIF p_state = 'failed' THEN
    UPDATE public.sitekit_previews p SET state = 'failed', finished_at = clock_timestamp(), reason = p_reason
     WHERE p.id = p_preview_id AND p.account_id = acct AND p.state = 'running';
  ELSIF p_state = 'void' THEN
    -- A preview that was marked running but whose agent never started (a sandbox, clone or policy refusal) is voided too.
    UPDATE public.sitekit_previews p SET state = 'void', started_at = NULL, finished_at = clock_timestamp(), reason = p_reason
     WHERE p.id = p_preview_id AND p.account_id = acct AND p.state IN ('requested', 'running');
    IF FOUND THEN
      DELETE FROM public.sitekit_preview_stamps t WHERE t.preview_id = p_preview_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'sitekit_preview_finish: unknown state' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION sitekit_preview_daily_compute_usd() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sitekit_preview_daily_compute_usd() TO app_user, agent_run_writer;
REVOKE ALL ON FUNCTION sitekit_preview_request(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sitekit_preview_request(uuid, numeric) TO app_user;
REVOKE ALL ON FUNCTION sitekit_preview_start(uuid), sitekit_preview_finish(uuid, text, text, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sitekit_preview_start(uuid), sitekit_preview_finish(uuid, text, text, integer, integer, integer, text) TO agent_run_writer;
ALTER FUNCTION sitekit_preview_daily_compute_usd() OWNER TO platform_ops;
ALTER FUNCTION sitekit_preview_request(uuid, numeric) OWNER TO platform_ops;
ALTER FUNCTION sitekit_preview_start(uuid) OWNER TO platform_ops;
ALTER FUNCTION sitekit_preview_finish(uuid, text, text, integer, integer, integer, text) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
