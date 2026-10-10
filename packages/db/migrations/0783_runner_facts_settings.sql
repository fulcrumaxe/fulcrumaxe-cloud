-- D#605 FL-1: what a runner IS (facts) and what its people SET on it (settings), as two side tables.
--
--   runner_facts      one row per runner: os, arch, memory bucket, cpu count and sandbox engine, as the runner reported them on its hello.
--                     Written only by runner_facts_record, which names the runner from app.runner_id (set only by the signature-verifying
--                     runner middleware). A claim, never a security input: routing may narrow or reorder what the claim filters allow, nothing more.
--   runner_settings   one row per runner that has been named or controlled: name (null = never named), labels, rank, pause (paused_at /
--                     paused_by), draining. Written only by runner_settings_apply, which re-derives the caller's membership and role from the
--                     session on every call. The row is made on first use, so an old runner has none and reads as "Unnamed".
--
-- Side tables, not columns of runners: platform_ops holds a table-wide write on runners (0711) and a new column would have inherited it
-- (the reason 0754, 0763 and 0777 keep side tables). platform_ops gets NO privilege on either table or function; runners is unchanged.
--
-- Two roles, so the runner's own path cannot touch settings and the workspace's path cannot touch facts: runner_facts_definer owns
-- runner_facts_record; runner_settings_definer owns runner_settings_apply. Each is NOLOGIN, has no member, is a member of nothing, holds
-- column grants for exactly what its body reads and writes, and a pinned search_path; EXECUTE goes to app_user alone (shape of 0777).
--
-- Who may do what in runner_settings_apply (the FL-8 matrix):
--   rename, pause, drain      the runner's registrant (still a member), or an owner / admin
--   labels, rank              an owner / admin only
--   resume                    an owner / admin; the registrant only when every pause and drain in place is their own (paused_by, drained_by) or there is none. It ends both.
--   pause, drain              an owner / admin pause (drain) overwrites paused_by (drained_by). A registrant's pause (drain) is REFUSED (42501) while one set by
--                             someone else is in place, so a registrant can never take over an admin's pause or drain and then undo it. A repeated pause by the
--                             same person keeps the first paused_at.
-- A revoked runner is refused (55000), a runner of another account does not exist for the caller (P0002), a non-member or a registrant who left
-- is refused (42501). Text is refused, not trimmed or repaired: a name with a control character, an invisible or bidirectional mark, or over 64
-- characters is invalid (22023), so what is stored is exactly what was sent. One helper, runner_name_valid, holds the name rule for the CHECK and the definer alike. Facts are enums, so they carry no free text at all.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging and renumber to stay above its highest.

DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['runner_facts_definer', 'runner_settings_definer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % still has a privileged attribute', n;
    END IF;
  END LOOP;
END
$$;

-- The name rule in one place, used by the CHECK and by runner_settings_apply so they cannot drift apart: 1 to 64 characters, no control character
-- (C0, DEL, C1), no Unicode Default_Ignorable_Code_Point (soft hyphen, combining grapheme joiner, Arabic letter mark U+061C, Hangul fillers, Mongolian
-- selectors, zero-width and bidirectional marks, U+2060..206F, variation selectors, U+3164, U+FFA0, tag characters ...), and at least one character that
-- is none of those, whitespace, or the blank braille cell U+2800, so a name cannot render as nothing.
CREATE FUNCTION runner_name_valid(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p IS NOT NULL AND char_length(p) BETWEEN 1 AND 64
     AND p !~ '[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]'
     AND p ~ '[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u2800\u3000]'
$$;
REVOKE ALL ON FUNCTION runner_name_valid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_name_valid(text) TO runner_settings_definer;

-- The label rule in one place: at most 16 distinct labels, each lowercase letters, digits and hyphens, starting with a letter or digit, up to 32 long.
CREATE FUNCTION runner_labels_valid(p text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p IS NOT NULL AND cardinality(p) <= 16 AND (cardinality(p) = 0 OR array_ndims(p) = 1)
     AND coalesce((SELECT bool_and(coalesce(l ~ '^[a-z0-9][a-z0-9-]{0,31}$', false)) AND count(*) = count(DISTINCT l) FROM unnest(p) AS l), true)
$$;
-- Not callable by PUBLIC (platform_ops would inherit that): only the role that writes labels needs it, to run the CHECK and its own argument test.
REVOKE ALL ON FUNCTION runner_labels_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_labels_valid(text[]) TO runner_settings_definer;

CREATE TABLE runner_facts (
  runner_id      uuid PRIMARY KEY,
  account_id     uuid NOT NULL,
  os             text NOT NULL CONSTRAINT runner_facts_os_check CHECK (os IN ('linux', 'macos')),
  arch           text NOT NULL CONSTRAINT runner_facts_arch_check CHECK (arch IN ('x64', 'arm64')),
  mem_gb_bucket  smallint NOT NULL CONSTRAINT runner_facts_mem_check CHECK (mem_gb_bucket IN (4, 8, 16, 32, 64, 128)),
  cpus           smallint NOT NULL CONSTRAINT runner_facts_cpus_check CHECK (cpus BETWEEN 1 AND 256),
  sandbox_engine text NOT NULL CONSTRAINT runner_facts_engine_check CHECK (sandbox_engine IN ('os_sandbox', 'microvm')),
  reported_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_facts FORCE ROW LEVEL SECURITY;

CREATE TABLE runner_settings (
  runner_id   uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  name        text CONSTRAINT runner_settings_name_check CHECK (name IS NULL OR runner_name_valid(name)),
  labels      text[] NOT NULL DEFAULT '{}' CONSTRAINT runner_settings_labels_check CHECK (runner_labels_valid(labels)),
  rank        integer NOT NULL DEFAULT 0 CONSTRAINT runner_settings_rank_check CHECK (rank BETWEEN 0 AND 1000),
  paused_at   timestamptz,
  paused_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  draining    boolean NOT NULL DEFAULT false,
  drained_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  CONSTRAINT runner_settings_paused_by_check CHECK (paused_by IS NULL OR paused_at IS NOT NULL),
  CONSTRAINT runner_settings_drained_by_check CHECK (drained_by IS NULL OR draining)
);
ALTER TABLE runner_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_settings FORCE ROW LEVEL SECURITY;

-- ---- grants and policies: facts -------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runner_facts_definer;
GRANT SELECT (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, reported_at),
      INSERT (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, reported_at),
      UPDATE (os, arch, mem_gb_bucket, cpus, sandbox_engine, reported_at) ON runner_facts TO runner_facts_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO runner_facts_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_facts_definer;
GRANT SELECT (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, reported_at) ON runner_facts TO app_user;

CREATE POLICY tenant_isolation_select ON runner_facts FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY runner_facts_definer_select ON runner_facts FOR SELECT TO runner_facts_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_facts_definer_insert ON runner_facts FOR INSERT TO runner_facts_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_facts_definer_update ON runner_facts FOR UPDATE TO runner_facts_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_facts_definer_select ON runners FOR SELECT TO runner_facts_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_facts_definer_select ON accounts FOR SELECT TO runner_facts_definer USING (true);

-- ---- grants and policies: settings ----------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runner_settings_definer;
GRANT SELECT (runner_id, account_id, name, labels, rank, paused_at, paused_by, draining, drained_by, updated_by, updated_at),
      INSERT (runner_id, account_id, updated_by),
      UPDATE (name, labels, rank, paused_at, paused_by, draining, drained_by, updated_by, updated_at) ON runner_settings TO runner_settings_definer;
GRANT SELECT (id, account_id, registered_by, revoked_at) ON runners TO runner_settings_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_settings_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_settings_definer;
GRANT SELECT (runner_id, account_id, name, labels, rank, paused_at, paused_by, draining, drained_by, updated_by, updated_at) ON runner_settings TO app_user;

CREATE POLICY tenant_isolation_select ON runner_settings FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY runner_settings_definer_select ON runner_settings FOR SELECT TO runner_settings_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_settings_definer_insert ON runner_settings FOR INSERT TO runner_settings_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_settings_definer_update ON runner_settings FOR UPDATE TO runner_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_settings_definer_select ON runners FOR SELECT TO runner_settings_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757 does.
CREATE POLICY runner_settings_definer_select ON account_members FOR SELECT TO runner_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY runner_settings_definer_select ON accounts FOR SELECT TO runner_settings_definer USING (true);

-- ---- ownership bracket (0777's shape) -------------------------------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_facts_definer', 'runner_settings_definer'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_facts_definer, runner_settings_definer;

-- ---- runner_facts_record --------------------------------------------------------------------------------------------
CREATE FUNCTION runner_facts_record(p_os text, p_arch text, p_mem_gb_bucket integer, p_cpus integer, p_sandbox_engine text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_facts_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_facts_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_os IS NULL OR p_os NOT IN ('linux', 'macos') OR p_arch IS NULL OR p_arch NOT IN ('x64', 'arm64')
     OR p_mem_gb_bucket IS NULL OR p_mem_gb_bucket NOT IN (4, 8, 16, 32, 64, 128) OR p_cpus IS NULL OR p_cpus NOT BETWEEN 1 AND 256
     OR p_sandbox_engine IS NULL OR p_sandbox_engine NOT IN ('os_sandbox', 'microvm') THEN
    RAISE EXCEPTION 'runner_facts_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_facts AS f (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine)
  VALUES (raw::uuid, acct, p_os, p_arch, p_mem_gb_bucket, p_cpus, p_sandbox_engine)
  ON CONFLICT (runner_id) DO UPDATE
    SET os = EXCLUDED.os, arch = EXCLUDED.arch, mem_gb_bucket = EXCLUDED.mem_gb_bucket, cpus = EXCLUDED.cpus,
        sandbox_engine = EXCLUDED.sandbox_engine, reported_at = now();
END;
$$;

-- ---- runner_settings_apply ------------------------------------------------------------------------------------------
CREATE FUNCTION runner_settings_apply(p_runner uuid, p_action text, p_name text, p_labels text[], p_rank integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct        uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr         uuid;
  v_role      text;
  v_reg       uuid;
  v_revoked   timestamptz;
  v_paused    timestamptz;
  v_paused_by uuid;
  v_draining  boolean;
  v_drained_by uuid;
  v_admin     boolean;
  v_owns      boolean;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_settings_apply: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call, never taken from the request.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'runner_settings_apply: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner IS NULL OR p_action IS NULL OR p_action NOT IN ('rename', 'labels', 'rank', 'pause', 'drain', 'resume') THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.registered_by, r.revoked_at INTO v_reg, v_revoked FROM public.runners r WHERE r.id = p_runner AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_settings_apply: no such runner' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'runner_settings_apply: the runner is removed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_admin := v_role IN ('owner', 'admin');
  v_owns := v_admin OR v_reg = usr;
  IF (p_action IN ('labels', 'rank') AND NOT v_admin) OR (p_action IN ('rename', 'pause', 'drain', 'resume') AND NOT v_owns) THEN
    RAISE EXCEPTION 'runner_settings_apply: not allowed for this caller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The argument for the action, checked before any write. Text is refused, not repaired.
  IF p_action = 'rename' AND NOT public.runner_name_valid(p_name) THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action = 'labels' AND NOT public.runner_labels_valid(p_labels) THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid labels' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action = 'rank' AND (p_rank IS NULL OR p_rank NOT BETWEEN 0 AND 1000) THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid rank' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.runner_settings (runner_id, account_id, updated_by) VALUES (p_runner, acct, usr) ON CONFLICT (runner_id) DO NOTHING;
  SELECT s.paused_at, s.paused_by, s.draining, s.drained_by INTO v_paused, v_paused_by, v_draining, v_drained_by FROM public.runner_settings s WHERE s.runner_id = p_runner AND s.account_id = acct FOR UPDATE;

  -- A registrant may not take over, or undo, a pause or drain someone else set. Only an owner / admin overwrites or clears another person's.
  IF NOT v_admin AND (
       (p_action IN ('pause', 'resume') AND v_paused IS NOT NULL AND v_paused_by IS DISTINCT FROM usr)
    OR (p_action IN ('drain', 'resume') AND v_draining AND v_drained_by IS DISTINCT FROM usr)) THEN
    RAISE EXCEPTION 'runner_settings_apply: a pause or drain set by someone else is in place' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.runner_settings s SET
    name       = CASE WHEN p_action = 'rename' THEN p_name ELSE s.name END,
    labels     = CASE WHEN p_action = 'labels' THEN p_labels ELSE s.labels END,
    rank       = CASE WHEN p_action = 'rank' THEN p_rank ELSE s.rank END,
    paused_at  = CASE p_action WHEN 'pause' THEN COALESCE(s.paused_at, now()) WHEN 'resume' THEN NULL ELSE s.paused_at END,
    paused_by  = CASE p_action WHEN 'pause' THEN usr WHEN 'resume' THEN NULL ELSE s.paused_by END,
    draining   = CASE p_action WHEN 'drain' THEN true WHEN 'resume' THEN false ELSE s.draining END,
    drained_by = CASE p_action WHEN 'drain' THEN usr WHEN 'resume' THEN NULL ELSE s.drained_by END,
    updated_by = usr,
    updated_at = now()
  WHERE s.runner_id = p_runner AND s.account_id = acct;
END;
$$;

-- ---- owners, execute grants, and the bracket closed -----------------------------------------------------------------
REVOKE ALL ON FUNCTION runner_facts_record(text, text, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_facts_record(text, text, integer, integer, text) TO app_user;
ALTER FUNCTION runner_facts_record(text, text, integer, integer, text) OWNER TO runner_facts_definer;
REVOKE ALL ON FUNCTION runner_settings_apply(uuid, text, text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_settings_apply(uuid, text, text, text[], integer) TO app_user;
ALTER FUNCTION runner_settings_apply(uuid, text, text, text[], integer) OWNER TO runner_settings_definer;
REVOKE CREATE ON SCHEMA public FROM runner_facts_definer, runner_settings_definer;

DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_facts_definer', 'runner_settings_definer'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
