-- D#7 DW-R4 (plan write-back): the receipt behind a plan update the platform merged by policy. A write-back has no work item and no review run, so the
-- receipt 0983 writes (which names both) can not cover it. This file adds the write-back's own definer and the one table that ties a receipt to the write-back.
--
--   * plan_writeback_receipts   one row per write-back: (account, write-back) is the key, so a write-back has at most one receipt, enforced by the database
--                               (the function also serialises on the write-back, so a late caller answers the first receipt). It points at an ordinary class 2 decision_receipts row of type merge_after_reviews with no work item
--                               and no run. app_user can read it; only merge_receipt_definer can insert. Both foreign keys are NO ACTION: a receipt outlives
--                               its subject, as for a work item.
--   * plan_writeback_receipt_write(write-back, head, chosen, dial version, catalogue version)
--                               owned by merge_receipt_definer (0983's role: no INSERT on decision_receipts of its own, it writes through decision_receipt_write).
--                               The account comes from the session and the actor is `policy` by construction (a session with a person or a token is refused).
--                               The write-back must be this account's, its recorded head must be the head named, and the gate must have recorded its merge
--                               (plan_writeback_merges, below) at that head with the same dial version and word; none is refused. `chosen` (act or announce)
--                               must also be what the repository's merge dial said at the version named (version 0 is the catalogue default, act). A replay
--                               answers the first receipt.
--   * plan_writeback_merges     the gate's own fact, as 0983's merged_by_gate fact is for a work item: one row per write-back, written by the gate straight after
--                               its merge call succeeds, in a transaction of its own (what the merge, the dial and the head were). The receipt keys on this fact and
--                               never on the queue entry's state: GitHub's own pull_request.closed can settle the entry as a person's merge (merged_by 'person', and the
--                               final-row guard of 0824 refuses correcting it) before the gate's transaction commits, and that must not cost the receipt, nor may a
--                               merge a person makes by hand be taken for the gate's. Append-only for app_user (INSERT and SELECT only).
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, P0002 nothing recorded, 22023 invalid argument.
-- Accepted risk, stated plainly: the gate and the caller share one login (app_user), as in 0983. A caller with raw SQL on it can create a write-back row, choose its
-- head, insert the fact itself, name dial version 0 with `act`, and get a receipt for a merge that never happened. The ordinary code paths can not choose any of
-- that. This function stops a call that names a merge no fact records; it does not stop someone who can write the fact.
-- Not covered: a crash after the merge call and before the fact commits leaves no fact. The entry then ends as a person's merge (GitHub's webhook settles it) and
-- the write-back gets no receipt and no report.
-- Expand-only. Numbered above main's top (0986) and above 0987, which another open change holds; re-checked right before merge.

CREATE TABLE plan_writeback_receipts (
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  plan_writeback_id uuid NOT NULL,
  receipt_id        uuid NOT NULL REFERENCES decision_receipts (id) ON DELETE NO ACTION,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, plan_writeback_id),
  UNIQUE (receipt_id),
  FOREIGN KEY (account_id, plan_writeback_id) REFERENCES plan_writebacks (account_id, id) ON DELETE NO ACTION
);
ALTER TABLE plan_writeback_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_writeback_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON plan_writeback_receipts FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY merge_receipt_definer_insert ON plan_writeback_receipts FOR INSERT TO merge_receipt_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY merge_receipt_definer_select ON plan_writeback_receipts FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT ON plan_writeback_receipts TO app_user;
GRANT SELECT, INSERT ON plan_writeback_receipts TO merge_receipt_definer;

CREATE TABLE plan_writeback_merges (
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  plan_writeback_id uuid NOT NULL,
  head_sha          text NOT NULL CONSTRAINT plan_writeback_merges_head_check CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  chosen            text NOT NULL CONSTRAINT plan_writeback_merges_chosen_check CHECK (chosen IN ('act', 'announce')),
  dial_version      integer NOT NULL CONSTRAINT plan_writeback_merges_dial_check CHECK (dial_version >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, plan_writeback_id),
  FOREIGN KEY (account_id, plan_writeback_id) REFERENCES plan_writebacks (account_id, id) ON DELETE NO ACTION
);
ALTER TABLE plan_writeback_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_writeback_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON plan_writeback_merges FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation_insert ON plan_writeback_merges FOR INSERT TO app_user
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY merge_receipt_definer_select ON plan_writeback_merges FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT, INSERT ON plan_writeback_merges TO app_user;
GRANT SELECT ON plan_writeback_merges TO merge_receipt_definer;

-- What the body reads besides the tables above, column by column, behind a row policy held to the caller's tenant.
GRANT SELECT (account_id, id, repo_id, head_sha) ON plan_writebacks TO merge_receipt_definer;
CREATE POLICY merge_receipt_definer_select ON plan_writebacks FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Ownership bracket (0983's shape).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'merge_receipt_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on merge_receipt_definer; cannot ALTER FUNCTION ... OWNER TO merge_receipt_definer';
    END IF;
    GRANT merge_receipt_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO merge_receipt_definer;

CREATE FUNCTION plan_writeback_receipt_write(
  p_plan_writeback_id uuid, p_head_sha text, p_chosen text, p_dial_version integer, p_catalogue_version integer
)
RETURNS TABLE (o_id uuid, o_replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_repo   uuid;
  v_head   text;
  v_fact   record;
  v_id     uuid;
  v_disp   text;
  v_preset text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: only a policy session writes this receipt' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_plan_writeback_id IS NULL OR p_head_sha IS NULL OR p_head_sha !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_chosen IS NULL OR p_chosen NOT IN ('act', 'announce')
     OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT w.repo_id, w.head_sha INTO v_repo, v_head FROM public.plan_writebacks w WHERE w.account_id = acct AND w.id = p_plan_writeback_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: no such plan update' USING ERRCODE = 'no_data_found';
  END IF;
  -- The gate's own fact, at the recorded head, saying what this call says. The queue entry's state is not consulted.
  SELECT m.head_sha, m.chosen, m.dial_version INTO v_fact FROM public.plan_writeback_merges m WHERE m.account_id = acct AND m.plan_writeback_id = p_plan_writeback_id;
  IF NOT FOUND OR v_head IS DISTINCT FROM p_head_sha OR v_fact.head_sha IS DISTINCT FROM p_head_sha THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: the gate recorded no merge of that plan update' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_fact.chosen IS DISTINCT FROM p_chosen OR v_fact.dial_version IS DISTINCT FROM p_dial_version THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One receipt per write-back; serialise so two callers at once answer the same one (the primary key is the backstop).
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_writeback_receipt:' || acct::text || ':' || p_plan_writeback_id::text, 0));
  SELECT l.receipt_id INTO v_id FROM public.plan_writeback_receipts l WHERE l.account_id = acct AND l.plan_writeback_id = p_plan_writeback_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, true; RETURN;
  END IF;

  -- What the receipt names must be what the dial said at the version given (0 is the catalogue default, act; a "use the default" version is act too).
  IF p_dial_version > 0 THEN
    SELECT s.disposition, s.preset INTO v_disp, v_preset FROM public.decision_settings s
     WHERE s.account_id = acct AND s.repo_id = v_repo AND s.decision_type = 'merge_after_reviews' AND s.version = p_dial_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_writeback_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_disp := CASE WHEN v_preset = 'default' THEN 'act' ELSE v_disp END;
  ELSE
    v_disp := 'act';
  END IF;
  IF p_chosen IS DISTINCT FROM v_disp THEN
    RAISE EXCEPTION 'plan_writeback_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_id := public.decision_receipt_write('human_over_the_loop', 'merge_after_reviews', p_chosen, 'ask', p_dial_version, '[]'::jsonb, NULL, NULL, p_catalogue_version);
  INSERT INTO public.plan_writeback_receipts (account_id, plan_writeback_id, receipt_id) VALUES (acct, p_plan_writeback_id, v_id);
  RETURN QUERY SELECT v_id, false;
END;
$$;

REVOKE ALL ON FUNCTION plan_writeback_receipt_write(uuid, text, text, integer, integer) FROM PUBLIC;
ALTER FUNCTION plan_writeback_receipt_write(uuid, text, text, integer, integer) OWNER TO merge_receipt_definer;
GRANT EXECUTE ON FUNCTION plan_writeback_receipt_write(uuid, text, text, integer, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM merge_receipt_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE merge_receipt_definer FROM CURRENT_USER;
  END IF;
END
$$;
