-- Partner host resolution and signup assignment (partner layer, row P02a).
--
-- Two SECURITY DEFINER functions with a pinned search_path, owned by a role of their own, partner_host_definer, in the shape of 0793's
-- memory_definer: NOLOGIN, no members (the migration role holds it only inside this file), column-level grants for exactly what the
-- bodies read and write, row policies for this role only, EXECUTE named per function. platform_ops owns nothing here and gains no
-- table, column or policy privilege; its one new privilege is EXECUTE on assign_partner_on_signup, because the login that creates
-- accounts is platform_ops (packages/core/src/auth/identity.ts) and the assignment has to run in that transaction.
--
--   resolve_host(hostname)
--       Answers ONE row for any text, never an error and never zero rows, so a caller cannot tell a lookup that missed from one that found
--       nothing. The columns are exactly (partner_id, product_name, logo_url, color_primary, color_accent, support_email, terms_url,
--       privacy_url, state), and state is one of active|suspended|unknown.
--         active     the host is a TXT-verified, attached, not-detached domain of a reseller whose status is active, whose branding is
--                    approved, and whose branding carries a product name, a terms URL and a privacy URL. Branding comes back.
--         suspended  the same domain rules, for a reseller whose status is suspended. Only partner_id comes back: the suspension page is in
--                    our brand, so no partner text or colour leaves the function.
--         unknown    anything else: an unverified, unattached, detached, pending-partner, unapproved-branding or missing-terms host, a host
--                    nobody owns, a hostname that is not in canonical form. All columns but state are NULL.
--       The comparison is an exact match on the stored hostname, which the partner_domains CHECK (0200) keeps lowercase, without a port and
--       without a trailing dot. The caller normalises first (packages/partners/src/host); a hostname that is not already in that form
--       simply matches nothing. State is derived from the current rows on every call, not stamped: a detach, a revoked approval or a
--       suspension changes the next answer.
--       logo_url is partner_branding.logo_object_key. Logo storage and serving belong to a later row (P09a), so the key is returned as
--       stored and the route that calls this emits null until that row defines what a URL for it is.
--       EXECUTE: app_user (the web tier's login) and nobody else.
--
--   assign_partner_on_signup(account, hostname)
--       Sets accounts.partner_id for a brand-new account that signed up on a partner host. It refuses (42501) when the account already has a
--       partner or a referrer, when it is older than 10 minutes, and when the host does not resolve to an active partner right now; it
--       answers P0002 for an account that does not exist or is soft-deleted and 22023 for a missing argument. It writes one
--       partner_audit_log row naming the account. Returns the partner id.
--       EXECUTE: platform_ops (the login that creates accounts) and nobody else. app_user, partner_user and PUBLIC are refused, so a
--       customer session cannot assign itself to a partner: accounts.partner_id stays settable only through this function.
--
-- Numbered above the highest migration on the code plane (0794) and above the numbers queued ahead of it (0795 to 0798). Re-check
-- against main right before merging.
DO $$
DECLARE
  n text := 'partner_host_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO partner_host_definer;

-- resolve_host reads four partner tables, a column list each. The row policies below show this role every row of them: what leaves the
-- function is decided by its body, and the columns stop at what the answer needs.
GRANT SELECT (partner_id, hostname, txt_verified_at, attached_at, detached_at) ON partner_domains TO partner_host_definer;
GRANT SELECT (id, kind, status) ON partners TO partner_host_definer;
GRANT SELECT (partner_id, product_name, logo_object_key, color_primary, color_accent, support_email, terms_url, privacy_url, status)
  ON partner_branding TO partner_host_definer;
-- assign_partner_on_signup reads an account's partner, referrer, age and soft-delete stamp, and sets its partner_id (nothing else).
GRANT SELECT (id, partner_id, referred_by_partner_id, created_at, deleted_at), UPDATE (partner_id) ON accounts TO partner_host_definer;
GRANT INSERT (partner_id, actor, action, payload) ON partner_audit_log TO partner_host_definer;

CREATE POLICY partner_host_definer_select ON partner_domains FOR SELECT TO partner_host_definer USING (true);
CREATE POLICY partner_host_definer_select ON partners FOR SELECT TO partner_host_definer USING (true);
CREATE POLICY partner_host_definer_select ON partner_branding FOR SELECT TO partner_host_definer USING (true);
CREATE POLICY partner_host_definer_select ON accounts FOR SELECT TO partner_host_definer USING (true);
-- The only write: an account with neither a partner nor a referrer, still live, gets a partner. Never cleared, never changed.
CREATE POLICY partner_host_definer_assign ON accounts FOR UPDATE TO partner_host_definer
  USING (partner_id IS NULL AND referred_by_partner_id IS NULL AND deleted_at IS NULL)
  WITH CHECK (partner_id IS NOT NULL AND referred_by_partner_id IS NULL);
CREATE POLICY partner_host_definer_audit ON partner_audit_log FOR INSERT TO partner_host_definer
  WITH CHECK (actor = 'signup' AND action = 'account_assigned');

-- Ownership bracket (0793's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on
-- public only for that transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'partner_host_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on partner_host_definer; cannot ALTER FUNCTION ... OWNER TO partner_host_definer';
    END IF;
    GRANT partner_host_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO partner_host_definer;

CREATE FUNCTION resolve_host(p_hostname text)
RETURNS TABLE (
  partner_id    uuid,
  product_name  text,
  logo_url      text,
  color_primary text,
  color_accent  text,
  support_email text,
  terms_url     text,
  privacy_url   text,
  state         text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_partner uuid;
  v_status  text;
BEGIN
  IF p_hostname IS NOT NULL THEN
    SELECT p.id, p.status
      INTO v_partner, v_status
      FROM public.partner_domains d
      JOIN public.partners p ON p.id = d.partner_id
     WHERE d.hostname = p_hostname
       AND d.txt_verified_at IS NOT NULL
       AND d.attached_at IS NOT NULL
       AND d.detached_at IS NULL
       AND p.kind = 'reseller'
       AND p.status IN ('active', 'suspended');

    IF v_status = 'suspended' THEN
      RETURN QUERY SELECT v_partner, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 'suspended'::text;
      RETURN;
    END IF;

    IF v_status = 'active' THEN
      RETURN QUERY
        SELECT p.id, b.product_name, b.logo_object_key, b.color_primary, b.color_accent, b.support_email,
               b.terms_url, b.privacy_url, 'active'::text
          FROM public.partners p
          JOIN public.partner_branding b ON b.partner_id = p.id
         WHERE p.id = v_partner
           AND b.status = 'approved'
           AND btrim(COALESCE(b.product_name, '')) <> ''
           AND btrim(COALESCE(b.terms_url, '')) <> ''
           AND btrim(COALESCE(b.privacy_url, '')) <> '';
      IF FOUND THEN
        RETURN;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, 'unknown'::text;
END;
$$;

CREATE FUNCTION assign_partner_on_signup(p_account_id uuid, p_hostname text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_partner_id  uuid;
  v_referrer_id uuid;
  v_created_at  timestamptz;
  v_deleted_at  timestamptz;
  v_host        record;
  v_rows        integer;
BEGIN
  IF p_account_id IS NULL OR p_hostname IS NULL THEN
    RAISE EXCEPTION 'assign_partner_on_signup: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.partner_id, a.referred_by_partner_id, a.created_at, a.deleted_at
    INTO v_partner_id, v_referrer_id, v_created_at, v_deleted_at
    FROM public.accounts a
   WHERE a.id = p_account_id;
  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'assign_partner_on_signup: account not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_partner_id IS NOT NULL OR v_referrer_id IS NOT NULL THEN
    RAISE EXCEPTION 'assign_partner_on_signup: the account already has a partner or a referrer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_created_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'assign_partner_on_signup: the account is older than 10 minutes' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_host FROM public.resolve_host(p_hostname);
  IF v_host.state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'assign_partner_on_signup: the host is not an active partner host' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The update policy only lets a row with neither a partner nor a referrer through, so a concurrent assignment changes 0 rows here.
  UPDATE public.accounts SET partner_id = v_host.partner_id WHERE id = p_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'assign_partner_on_signup: the account already has a partner or a referrer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.partner_audit_log (partner_id, actor, action, payload)
    VALUES (v_host.partner_id, 'signup', 'account_assigned', jsonb_build_object('account_id', p_account_id));
  RETURN v_host.partner_id;
END;
$$;

REVOKE ALL ON FUNCTION resolve_host(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_partner_on_signup(uuid, text) FROM PUBLIC;
ALTER FUNCTION resolve_host(text) OWNER TO partner_host_definer;
ALTER FUNCTION assign_partner_on_signup(uuid, text) OWNER TO partner_host_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION resolve_host(text) TO app_user;
GRANT EXECUTE ON FUNCTION assign_partner_on_signup(uuid, text) TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM partner_host_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE partner_host_definer FROM CURRENT_USER;
  END IF;
END
$$;
