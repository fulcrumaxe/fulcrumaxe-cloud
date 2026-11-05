-- D#601 MEM-10: the reversal receipt of an auto-approved memory entry, for every Undo that takes it out of force.
--
-- 0986 left the receipt only for a retire: memory_auto_approve_reversal refused any entry that was not `retired`. The other two ways a person takes an
-- auto-approved entry back, "undo approval" (memory_decide to `proposed`) and delete (memory_delete), left no receipt. Undo approval also hid its own
-- evidence: memory_decide writes the person's memory.reverted row, and the old "latest step into force" check then found that row, not the policy's.
--
-- This replaces the function (same signature, same owner, same ACL, same pinned search_path, every guard kept) so that it also answers for:
--   * `proposed`, when the entry's latest step into force (approved, restored or reverted) is a person's revert OF AN APPROVAL, and the step before it is
--     the policy's approval. A reconsider or a renew also writes memory.reverted, but from rejected or expired, so it is not an Undo of an approval; and a
--     person's approval or restore between the policy's and the revert makes the step before the revert a person's, so nothing is reversed.
--   * `deleted`, when the entry was approved when it was deleted (prior_status) and its latest step into force is the policy's approval.
--   * `retired`, as before: the latest step into force is the policy's approval.
-- Anything else still answers NULL (a person approved it, it was never auto-approved) or raises (another account's entry, an entry in any other state, a
-- session with no person). A repeat answers the first receipt, because the writer finds the reversal of the same policy receipt (decision_receipt_write_reversal).
--
-- The only new access is SELECT on memory_entries.prior_status for the definer role (to tell a deleted approved entry from a deleted retired one), under
-- the existing per-account row policy. Expand-only; no table, role or column is added. Numbered after 0990, the highest on main, and after the open changes
-- that hold 0991 and 0992; re-check against the code plane's highest right before merging, migrations merge in number order.

GRANT SELECT (prior_status) ON memory_entries TO memory_auto_approve_definer;

-- Replacing a function needs the owning role (0765's bracket, as 0986 and 0987 use it); reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_auto_approve_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_auto_approve_definer; cannot replace its functions';
    END IF;
    GRANT memory_auto_approve_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION memory_auto_approve_reversal(p_entry_id uuid, p_catalogue_version integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_status  text;
  v_prior   text;
  v_action  text;
  v_actor   text;
  v_payload jsonb;
  v_orig    uuid;
  v_run     uuid;
  v_dial    integer;
  v_id      uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A reversal is a person's: the receipt writer takes the actor from this session and checks the membership.
  IF usr IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: only a member''s session reverses' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_entry_id IS NULL OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT m.status, m.prior_status INTO v_status, v_prior FROM public.memory_entries m WHERE m.id = p_entry_id AND m.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status NOT IN ('retired', 'proposed', 'deleted') THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: the entry has not been taken back' USING ERRCODE = 'no_data_found';
  END IF;
  -- A deleted entry that was not approved when it was deleted (a retired one) was already answered by its retire.
  IF v_status = 'deleted' AND v_prior IS DISTINCT FROM 'approved' THEN
    RETURN NULL;
  END IF;

  -- The latest step that put the entry in force.
  SELECT a.action, a.actor, a.payload INTO v_action, v_actor, v_payload FROM public.audit_log a
   WHERE a.account_id = acct AND a.action IN ('memory.approved', 'memory.restored', 'memory.reverted') AND a.payload ->> 'entry_id' = p_entry_id::text
   ORDER BY a.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_status = 'proposed' THEN
    -- It must be the person's Undo of an approval; the policy's approval is then the step before it.
    IF v_action IS DISTINCT FROM 'memory.reverted' OR v_payload ->> 'from_status' IS DISTINCT FROM 'approved' THEN
      RETURN NULL;
    END IF;
    SELECT a.action, a.actor, a.payload INTO v_action, v_actor, v_payload FROM public.audit_log a
     WHERE a.account_id = acct AND a.action IN ('memory.approved', 'memory.restored', 'memory.reverted') AND a.payload ->> 'entry_id' = p_entry_id::text
     ORDER BY a.created_at DESC OFFSET 1 LIMIT 1;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;
  -- The step in force must be the policy's approval; a person's approval or restore means nothing to reverse here.
  IF v_action IS DISTINCT FROM 'memory.approved' OR v_actor IS DISTINCT FROM 'policy:memory_auto_approve' THEN
    RETURN NULL;
  END IF;
  v_orig := NULLIF(v_payload ->> 'receipt_id', '')::uuid;
  SELECT r.run_id, r.dial_version INTO v_run, v_dial FROM public.decision_receipts r
   WHERE r.id = v_orig AND r.account_id = acct AND r.decision_type = 'memory_auto_approve';
  IF NOT FOUND OR v_run IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT o_id INTO v_id FROM public.decision_receipt_write_reversal(v_orig, 'reversed', 'reverse_refused', v_dial, v_run, p_catalogue_version);
  RETURN v_id;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_auto_approve_definer FROM CURRENT_USER;
  END IF;
END
$$;
