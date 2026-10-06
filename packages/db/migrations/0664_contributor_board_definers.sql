-- Contributor task board, definers half (D#70 BRD-1b). No table or column is added.
--
-- Every function is owned by platform_ops, has a pinned search_path and is
-- REVOKEd FROM PUBLIC (Gate G1 C-2); the definers take the caller from
-- current_member_user_id() / current_member_role() only (C-3). Not-found is one
-- error (P0002) for a missing, unlisted, invisible or someone else's row; a
-- refusal is P0001 with the reason as its message. Part 3 is the merge-gating
-- write hardening (C3b, 1b-11): a direct platform_ops login, the internet-facing
-- web pool, cannot write the claim tables. In a definer session_user is the app
-- login, so the definers still can.
GRANT CREATE ON SCHEMA public TO platform_ops;

-- 1. What the definers read beyond 0657 (column-scoped, tenant-blind only
--    where a public listing needs it).
GRANT SELECT (work_item_id) ON agent_runs TO platform_ops;
GRANT SELECT (title) ON work_items TO platform_ops;
-- Only a public, listed item's title is public, so a definer may read exactly
-- those across tenants, and never in a direct login.
CREATE POLICY platform_ops_board_title ON work_items FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops'
         AND EXISTS (SELECT 1 FROM board_listings l
                      WHERE l.account_id = work_items.account_id AND l.work_item_id = work_items.id
                        AND l.visibility = 'public' AND l.state = 'listed'));

-- 1b-12 (C4): a listing id is globally unique and app_user never chooses or
-- changes it, so a tenant cannot squat another tenant's public id. The DO block
-- only gives a readable error; the index build fails on duplicates anyway.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM board_listings GROUP BY id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'board_listings has duplicate ids; resolve them before this migration';
  END IF;
END $$;
CREATE UNIQUE INDEX board_listings_id_key ON board_listings (id);
REVOKE INSERT, UPDATE ON board_listings FROM app_user;
GRANT INSERT (account_id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope, item_kind,
              state, listed_by, created_at, updated_at) ON board_listings TO app_user;
GRANT UPDATE (work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope, item_kind, state,
              listed_by, updated_at) ON board_listings TO app_user;

-- 2. The functions.
CREATE FUNCTION board_cap_defaults()
RETURNS TABLE (model_feature_usd numeric, model_small_usd numeric, compute_usd numeric,
               max_active_per_claimant int, max_active_per_payer int, reclaim_cooldown_hours int)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT 250::numeric, 60::numeric, 5::numeric, 3, 10, 24;
$$;

-- claim_listing: one transaction, both tenants (C-5). Locks the listing row
-- first, so 20 concurrent claims give one active claim; the per-claimant and
-- per-payer counts are serialised by advisory locks taken in a fixed order.
CREATE FUNCTION claim_listing(listing_id uuid, cap_model_usd numeric, cap_compute_usd numeric)
RETURNS TABLE (claim_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid := public.current_member_user_id();
  d       record;
  l       record;
  v_model numeric := cap_model_usd;
  v_comp  numeric := cap_compute_usd;
  v_max   numeric;
  v_claim uuid := gen_random_uuid();
  v_fund  uuid := gen_random_uuid();
  v_exp   timestamptz;
  v_ttl   integer;
BEGIN
  IF usr IS NULL OR acct IS NULL OR public.current_member_role() NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO d FROM public.board_cap_defaults();
  -- Defence in depth behind board_listings_id_key: count every account's rows.
  IF (SELECT count(*) FROM public.board_listings x WHERE x.id = listing_id) > 1 THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Visible = listed, on an enabled board of an active account, and either
  -- public or the caller is a member of the listing's account.
  SELECT bl.*, s.claim_ttl_hours INTO l
    FROM public.board_listings bl
    JOIN public.board_repo_settings s ON s.account_id = bl.account_id AND s.repo_id = bl.repo_id
   WHERE bl.id = listing_id AND bl.state = 'listed' AND s.enabled AND public.account_is_active(bl.account_id)
     AND (bl.visibility = 'public'
          OR EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = bl.account_id AND m.user_id = usr))
     FOR UPDATE OF bl;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'payer_not_active';
  END IF;
  -- C-6: NaN and the infinities pass a numeric column, and NaN sorts above
  -- every number, so name them before the range test.
  v_max := CASE WHEN lower(l.item_kind) = 'small' THEN d.model_small_usd ELSE d.model_feature_usd END;
  IF v_model IS NULL OR v_comp IS NULL
     OR v_model IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
     OR v_comp IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
     OR v_model < 0.0001 OR v_model > v_max OR v_comp < 0.0001 OR v_comp > d.compute_usd THEN
    RAISE EXCEPTION 'invalid_cap';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('board-claimant:' || usr::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('board-payer:' || acct::text, 0));

  -- Lazy expiry: a claim still active past expires_at is expired now, and its funding closes.
  WITH x AS (
    UPDATE public.task_claims c SET state = 'expired', updated_at = now()
     WHERE c.account_id = l.account_id AND c.listing_id = l.id AND c.state = 'active' AND c.expires_at <= now()
    RETURNING c.payer_account_ref, c.funding_ref)
  UPDATE public.claim_fundings f SET state = 'closed', updated_at = now()
    FROM x WHERE f.account_id = x.payer_account_ref AND f.id = x.funding_ref;

  IF EXISTS (SELECT 1 FROM public.task_claims c
              WHERE c.account_id = l.account_id AND c.listing_id = l.id AND c.state IN ('active', 'in_review')) THEN
    RAISE EXCEPTION 'already_claimed';
  END IF;
  IF (SELECT count(*) FROM public.task_claims c WHERE c.claimant_user_id = usr
        AND (c.state = 'in_review' OR (c.state = 'active' AND c.expires_at > now()))) >= d.max_active_per_claimant THEN
    RAISE EXCEPTION 'claim_limit';
  END IF;
  IF (SELECT count(*) FROM public.task_claims c WHERE c.payer_account_ref = acct
        AND (c.state = 'in_review' OR (c.state = 'active' AND c.expires_at > now()))) >= d.max_active_per_payer THEN
    RAISE EXCEPTION 'payer_claim_limit';
  END IF;
  IF EXISTS (SELECT 1 FROM public.task_claims c
              WHERE c.account_id = l.account_id AND c.listing_id = l.id AND c.claimant_user_id = usr
                AND ((c.state = 'released' AND c.updated_at > now() - make_interval(hours => d.reclaim_cooldown_hours))
                  OR (c.state = 'expired' AND c.expires_at > now() - make_interval(hours => d.reclaim_cooldown_hours)))) THEN
    RAISE EXCEPTION 'reclaim_cooldown';
  END IF;

  v_exp := now() + make_interval(hours => l.claim_ttl_hours);
  INSERT INTO public.task_claims (account_id, id, listing_id, claimant_user_id, claimant_was_member, payer_account_ref,
                                  funding_ref, spec_sha256, expires_at)
  VALUES (l.account_id, v_claim, l.id, usr,
          EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = l.account_id AND m.user_id = usr),
          acct, v_fund, l.spec_sha256, v_exp);
  INSERT INTO public.claim_fundings (account_id, id, claim_ref, listing_ref, kind, cap_model_usd, cap_compute_usd)
  VALUES (acct, v_fund, v_claim, l.id, 'self', v_model, v_comp);
  -- The maintainer's audit row carries nothing about the payer or the caps.
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (l.account_id, usr::text, 'board.claim_created',
          jsonb_build_object('claim_id', v_claim, 'listing_id', l.id), clock_timestamp()),
         (acct, usr::text, 'board.claim_funded',
          jsonb_build_object('claim_id', v_claim, 'listing_id', l.id, 'funding_id', v_fund,
                             'cap_model_usd', v_model, 'cap_compute_usd', v_comp), clock_timestamp());
  RETURN QUERY SELECT v_claim, v_exp;
END $$;

-- release_claim: the claimant, or an owner/admin of the payer account acting
-- in that account's own context (C-7). Anyone else gets the same not-found.
CREATE FUNCTION release_claim(claim_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := public.current_member_user_id();
  c    record;
BEGIN
  SELECT tc.* INTO c FROM public.task_claims tc WHERE tc.id = claim_id FOR UPDATE;
  IF usr IS NULL OR NOT FOUND OR NOT (c.claimant_user_id = usr
       OR (c.payer_account_ref = acct AND public.current_member_role() IN ('owner', 'admin'))) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.state <> 'active' THEN
    RAISE EXCEPTION 'claim_not_active';
  END IF;
  UPDATE public.task_claims t SET state = 'released', updated_at = now() WHERE t.account_id = c.account_id AND t.id = c.id;
  UPDATE public.claim_fundings f SET state = 'closed', updated_at = now()
   WHERE f.account_id = c.payer_account_ref AND f.id = c.funding_ref;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (c.account_id, usr::text, 'board.claim_released', jsonb_build_object('claim_id', c.id), clock_timestamp()),
         (c.payer_account_ref, usr::text, 'board.claim_released',
          jsonb_build_object('claim_id', c.id, 'funding_id', c.funding_ref), clock_timestamp());
END $$;

-- my_claims: the caller's own claims, a fixed column list with no maintainer account_id.
CREATE FUNCTION my_claims()
RETURNS TABLE (claim_id uuid, listing_id uuid, state text, pr_number bigint, spec_sha256 text,
               expires_at timestamptz, merged_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT c.id, c.listing_id,
         CASE WHEN c.state = 'active' AND c.expires_at <= now() THEN 'expired' ELSE c.state END,
         c.pr_number, c.spec_sha256, c.expires_at, c.merged_at, c.created_at
    FROM public.task_claims c
   WHERE c.claimant_user_id = public.current_member_user_id()
   ORDER BY c.created_at DESC;
END $$;

-- claim_funding_for_run: the payer's funding for a run, or nothing. Every link
-- between the two tenants is checked on both sides (C-1 b), and the payer must
-- still be active with the claimant still an owner/admin of it (C-7).
CREATE FUNCTION claim_funding_for_run(run_id uuid)
RETURNS TABLE (funding_id uuid, payer_ref uuid, claim_id uuid, cap_model_usd numeric, cap_compute_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT f.id, f.account_id, c.id, f.cap_model_usd, f.cap_compute_usd
    FROM public.agent_runs r
    JOIN public.board_listings l ON l.account_id = r.account_id AND l.work_item_id = r.work_item_id
    JOIN public.task_claims c ON c.account_id = l.account_id AND c.listing_id = l.id
    JOIN public.claim_fundings f ON f.account_id = c.payer_account_ref AND f.id = c.funding_ref
   WHERE r.id = run_id
     AND f.claim_ref = c.id AND f.listing_ref = c.listing_id
     AND (c.state = 'in_review' OR (c.state = 'active' AND c.expires_at > now()))
     AND f.state = 'active'
     AND public.account_is_active(f.account_id)
     AND EXISTS (SELECT 1 FROM public.account_members m
                  WHERE m.account_id = c.payer_account_ref AND m.user_id = c.claimant_user_id
                    AND m.role IN ('owner', 'admin'))
   ORDER BY c.created_at DESC LIMIT 1;
$$;

-- board_public_listings: the name resolves case-insensitively, and only when
-- exactly one enabled board matches (C-4). Returns no account, payer or cap.
CREATE FUNCTION board_public_listings(repo_full_name text)
RETURNS TABLE (listing_id uuid, full_name text, title text, spec_snapshot text, file_scope text[],
               item_kind text, claim_state text, claimant_login text, pr_number bigint, attestation_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH m AS (
    SELECT r.account_id, r.id AS repo_id, r.gh_owner || '/' || r.gh_name AS full_name
      FROM public.repos r
      JOIN public.board_repo_settings s ON s.account_id = r.account_id AND s.repo_id = r.id
     WHERE s.enabled AND lower(r.gh_owner || '/' || r.gh_name) = lower(repo_full_name))
  SELECT l.id, m.full_name, w.title, l.spec_snapshot, l.file_scope, l.item_kind,
         CASE WHEN cl.state = 'active' AND cl.expires_at <= now() THEN 'expired' ELSE cl.state END,
         u.github_login, cl.pr_number, att.id
    FROM m
    JOIN public.board_listings l ON l.account_id = m.account_id AND l.repo_id = m.repo_id
                                AND l.visibility = 'public' AND l.state = 'listed'
    LEFT JOIN public.work_items w ON w.account_id = l.account_id AND w.id = l.work_item_id
    LEFT JOIN LATERAL (SELECT c.* FROM public.task_claims c
                        WHERE c.account_id = l.account_id AND c.listing_id = l.id
                          AND (c.state IN ('in_review', 'merged') OR (c.state = 'active' AND c.expires_at > now()))
                        ORDER BY c.created_at DESC LIMIT 1) cl ON true
    LEFT JOIN public.users u ON u.id = cl.claimant_user_id
    LEFT JOIN LATERAL (SELECT a.id FROM public.claim_attestations a
                        WHERE a.account_id = cl.account_id AND a.claim_id = cl.id
                        ORDER BY a.created_at DESC LIMIT 1) att ON true
   WHERE (SELECT count(*) FROM m) = 1 AND public.account_is_active(l.account_id)
   ORDER BY l.created_at DESC;
END $$;

-- 3. 1b-11: the write hardening.
--
-- Narrow grants: a direct platform_ops UPDATE reaches state and updated_at only.
REVOKE UPDATE ON task_claims FROM platform_ops;
REVOKE UPDATE ON claim_fundings FROM platform_ops;
GRANT UPDATE (state, updated_at) ON task_claims TO platform_ops;
GRANT UPDATE (state, updated_at) ON claim_fundings TO platform_ops;

-- 0642's write guard for the three claim tables. A platform_ops login writes
-- nothing except a state-only UPDATE of a claim or funding (the expiry sweep
-- and the staff disable), and that update may not leave a terminal state.
CREATE FUNCTION board_claims_write_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    IF TG_OP = 'INSERT' OR TG_TABLE_NAME = 'claim_attestations' THEN
      RAISE EXCEPTION '%: platform_ops may not INSERT or UPDATE directly; use the definers', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (to_jsonb(NEW) - 'state' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'updated_at') THEN
      RAISE EXCEPTION '%: platform_ops may change state and updated_at only', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.state IN ('merged', 'closed_unmerged', 'released', 'expired', 'revoked', 'failed', 'closed')
       AND NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION '%: a terminal state cannot be left by a platform_ops login', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 0642's identity freeze: for every role, the owner included. funding_ref is
-- set once at INSERT (claim_listing draws both ids first), so it needs no
-- NULL-to-value exception.
CREATE FUNCTION board_claims_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'task_claims' THEN
    IF (NEW.account_id, NEW.id, NEW.listing_id, NEW.claimant_user_id, NEW.payer_account_ref, NEW.funding_ref)
       IS DISTINCT FROM (OLD.account_id, OLD.id, OLD.listing_id, OLD.claimant_user_id, OLD.payer_account_ref, OLD.funding_ref) THEN
      RAISE EXCEPTION 'task_claims: identity columns are set once' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF (NEW.account_id, NEW.id, NEW.claim_ref, NEW.listing_ref, NEW.kind, NEW.cap_model_usd, NEW.cap_compute_usd)
       IS DISTINCT FROM (OLD.account_id, OLD.id, OLD.claim_ref, OLD.listing_ref, OLD.kind, OLD.cap_model_usd, OLD.cap_compute_usd) THEN
    RAISE EXCEPTION 'claim_fundings: identity columns and caps are set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER task_claims_write_guard BEFORE INSERT OR UPDATE ON task_claims
  FOR EACH ROW EXECUTE FUNCTION board_claims_write_guard();
CREATE TRIGGER claim_fundings_write_guard BEFORE INSERT OR UPDATE ON claim_fundings
  FOR EACH ROW EXECUTE FUNCTION board_claims_write_guard();
CREATE TRIGGER claim_attestations_write_guard BEFORE INSERT OR UPDATE ON claim_attestations
  FOR EACH ROW EXECUTE FUNCTION board_claims_write_guard();
CREATE TRIGGER task_claims_identity_immutable BEFORE UPDATE ON task_claims
  FOR EACH ROW EXECUTE FUNCTION board_claims_identity_immutable();
CREATE TRIGGER claim_fundings_identity_immutable BEFORE UPDATE ON claim_fundings
  FOR EACH ROW EXECUTE FUNCTION board_claims_identity_immutable();

-- 4. ACLs and ownership (C-2).
REVOKE ALL ON FUNCTION board_cap_defaults() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_listing(uuid, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION my_claims() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_funding_for_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION board_public_listings(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION board_claims_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION board_claims_identity_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION board_cap_defaults() TO app_user, platform_ops;
GRANT EXECUTE ON FUNCTION claim_listing(uuid, numeric, numeric) TO app_user;
GRANT EXECUTE ON FUNCTION release_claim(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION my_claims() TO app_user;
GRANT EXECUTE ON FUNCTION board_public_listings(text) TO app_user;

ALTER FUNCTION board_cap_defaults() OWNER TO platform_ops;
ALTER FUNCTION claim_listing(uuid, numeric, numeric) OWNER TO platform_ops;
ALTER FUNCTION release_claim(uuid) OWNER TO platform_ops;
ALTER FUNCTION my_claims() OWNER TO platform_ops;
ALTER FUNCTION claim_funding_for_run(uuid) OWNER TO platform_ops;
ALTER FUNCTION board_public_listings(text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
