-- D#601 MEM-4b1: the three time sweeps of the memory store. 0793 left `expired` to "sweeps in later changes", 0806 stamps `last_recalled_at`
-- for the retirement sweep, and memory_delete (0793) allows a restore for 30 days. These functions are what moves an entry on when time passes:
--
--   memory_sweep_expire(limit)   a `proposed` entry whose expires_at has passed becomes `expired`. memory_decide already takes it back
--                                (expired -> proposed, with a new 14-day expiry), so "Renew" needs nothing new.
--   memory_sweep_retire(limit)   an `approved` entry nobody has used for 90 days becomes `retired`. "Used" counts from the newest of the last
--                                recall (0806's stamp), the approval and the row's creation. The creation time only matters if an approval
--                                time is missing; the newest-of rule (not "the last recall, else the approval") is what lets a Restore stick:
--                                a retired entry is never recalled, so after a Restore its last recall is older than 90 days while its
--                                approval is fresh. memory_decide already takes it back (retired -> approved).
--   memory_sweep_purge(limit)    a `deleted` entry whose deleted_at is 30 days old or more is removed. That is the same boundary at which
--                                memory_delete stops allowing a restore, so a row can be restored or purged, never both and never neither.
--                                Its open records go with it (0835, ON DELETE CASCADE); the versions it replaced stay as history. Runs that
--                                recalled it keep its id, shown as "Deleted entry".
--   memory_history_read(id)      one entry's permanent history, read from those audit rows (0653's shape; see the function below).
--
-- Each sweep writes the audit row of the existing actions, in the same transaction and with the same fixed keys (entry_id, scope, kind,
-- author_kind, from_status, to_status, version); never the text. The actions are memory.expired (new), memory.retired (as a person's retire)
-- and memory.purged (new; to_status is NULL: a purged row has no status). The actor is the fixed 'system:memory_sweep'. The audit rows are the
-- permanent history, so they outlive a purge.
--
-- Who may run them: the reconciler's login (platform_ops) holds EXECUTE on the three functions and nothing else; it gains no grant on any
-- table. The functions and the row rights belong to a role of their own, memory_sweep_definer, in 0806's shape: NOLOGIN, no members (the
-- migration role holds it only inside this file), column grants for exactly what the bodies read and write, row policies for this role only,
-- a pinned search_path. The rules are in the row policies too, so the role can only move a proposal to `expired` and an approved entry to
-- `retired`, and can only delete a row that has been `deleted` for 30 days, whatever a function body says. The functions take no account,
-- id or time: the only input is a batch size (1 to 1000), so a caller can make a sweep run sooner or in smaller steps and nothing else.
--
-- Threat model, plainly: a caller with EXECUTE (platform_ops, or a stolen platform_ops credential) can only apply the time rules early. It
-- cannot pick an entry, an account or a date, cannot read any text, and every change it causes is an audited, reversible step except the
-- purge, which only reaches rows a person deleted 30 days ago and could no longer restore.
--
-- Only the newest version of an entry can be `deleted` (memory_delete refuses a superseded version, and memory_edit refuses a deleted one), so
-- the purge only ever removes the head of a version chain; the older versions stay as history. 0793's version CHECK, which refuses a later
-- version without a predecessor, therefore never stands in its way, and stays as it is (memory-run-counts.pg.test.ts pins that).
--
-- Expand-only: a role, three sweep functions, one history reader, three partial indexes (they keep each sweep off a full-table scan),
-- grants, row policies for the new role and one reconcile_jobs row. No column, constraint or existing function changes. Numbered above the
-- highest migration on the code plane (0898) and the one held by an open change (0899). Re-check against main's highest right before merging;
-- migrations merge in number order.
DO $$
DECLARE
  n text := 'memory_sweep_definer';
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

CREATE INDEX memory_entries_sweep_expire_idx ON memory_entries (expires_at) WHERE status = 'proposed';
CREATE INDEX memory_entries_sweep_retire_idx ON memory_entries ((GREATEST(last_recalled_at, approved_at, created_at))) WHERE status = 'approved';
CREATE INDEX memory_entries_sweep_purge_idx ON memory_entries (deleted_at) WHERE status = 'deleted';

GRANT USAGE ON SCHEMA public TO memory_sweep_definer;
GRANT SELECT (id, account_id, scope, kind, author_kind, status, version, approved_at, expires_at, last_recalled_at, deleted_at, created_at),
      UPDATE (status, updated_at),
      DELETE ON memory_entries TO memory_sweep_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO memory_sweep_definer;

-- The time rules again, as row policies for this role only. 0793 forces row security on memory_entries, so these bind the functions' owner.
CREATE POLICY memory_sweep_definer_select ON memory_entries FOR SELECT TO memory_sweep_definer
  USING (status IN ('proposed', 'approved', 'deleted', 'expired', 'retired'));
CREATE POLICY memory_sweep_definer_update ON memory_entries FOR UPDATE TO memory_sweep_definer
  USING ((status = 'proposed' AND expires_at <= now())
      OR (status = 'approved' AND GREATEST(last_recalled_at, approved_at, created_at) <= now() - interval '90 days'))
  WITH CHECK (status IN ('expired', 'retired'));
CREATE POLICY memory_sweep_definer_delete ON memory_entries FOR DELETE TO memory_sweep_definer
  USING (status = 'deleted' AND deleted_at <= now() - interval '30 days');
CREATE POLICY memory_sweep_definer_audit ON audit_log FOR INSERT TO memory_sweep_definer
  WITH CHECK (actor = 'system:memory_sweep' AND action IN ('memory.expired', 'memory.retired', 'memory.purged'));

-- Ownership bracket (0806's shape): the migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on public only for that
-- transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_sweep_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_sweep_definer; cannot ALTER FUNCTION ... OWNER TO memory_sweep_definer';
    END IF;
    GRANT memory_sweep_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO memory_sweep_definer;

-- Each sweep takes the oldest due rows first, re-checks the status in the UPDATE or DELETE itself, and writes one audit row per row it changed.
-- Returns how many. Expire and retire skip a row another transaction holds (a person deciding it right now; the next pass gets it if it is
-- still due). The purge does not lock ahead (FOR UPDATE would need an UPDATE right on deleted rows, which this role has no use for): its DELETE
-- waits for a person's restore of the same row and then finds it no longer `deleted`.
CREATE FUNCTION memory_sweep_expire(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts timestamptz := clock_timestamp();
  n  integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_message: the batch size is 1 to 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH due AS (
    SELECT e.id FROM public.memory_entries e
     WHERE e.status = 'proposed' AND e.expires_at <= ts
     ORDER BY e.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), done AS (
    UPDATE public.memory_entries e SET status = 'expired', updated_at = ts
      FROM due WHERE e.id = due.id AND e.status = 'proposed' AND e.expires_at <= ts
    RETURNING e.id, e.account_id, e.scope, e.kind, e.author_kind, e.version
  )
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  SELECT d.account_id, 'system:memory_sweep', 'memory.expired',
         jsonb_build_object('entry_id', d.id, 'scope', d.scope, 'kind', d.kind, 'author_kind', d.author_kind, 'from_status', 'proposed',
                            'to_status', 'expired', 'version', d.version), ts
    FROM done d;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION memory_sweep_retire(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts timestamptz := clock_timestamp();
  n  integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_message: the batch size is 1 to 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH due AS (
    SELECT e.id FROM public.memory_entries e
     WHERE e.status = 'approved' AND GREATEST(e.last_recalled_at, e.approved_at, e.created_at) <= ts - interval '90 days'
     ORDER BY GREATEST(e.last_recalled_at, e.approved_at, e.created_at) LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), done AS (
    UPDATE public.memory_entries e SET status = 'retired', updated_at = ts
      FROM due WHERE e.id = due.id AND e.status = 'approved'
       AND GREATEST(e.last_recalled_at, e.approved_at, e.created_at) <= ts - interval '90 days'
    RETURNING e.id, e.account_id, e.scope, e.kind, e.author_kind, e.version
  )
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  SELECT d.account_id, 'system:memory_sweep', 'memory.retired',
         jsonb_build_object('entry_id', d.id, 'scope', d.scope, 'kind', d.kind, 'author_kind', d.author_kind, 'from_status', 'approved',
                            'to_status', 'retired', 'version', d.version), ts
    FROM done d;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION memory_sweep_purge(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts timestamptz := clock_timestamp();
  n  integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_message: the batch size is 1 to 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH due AS (
    SELECT e.id FROM public.memory_entries e
     WHERE e.status = 'deleted' AND e.deleted_at <= ts - interval '30 days'
     ORDER BY e.deleted_at LIMIT p_limit
  ), done AS (
    DELETE FROM public.memory_entries e
     USING due WHERE e.id = due.id AND e.status = 'deleted' AND e.deleted_at <= ts - interval '30 days'
    RETURNING e.id, e.account_id, e.scope, e.kind, e.author_kind, e.version
  )
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  SELECT d.account_id, 'system:memory_sweep', 'memory.purged',
         jsonb_build_object('entry_id', d.id, 'scope', d.scope, 'kind', d.kind, 'author_kind', d.author_kind, 'from_status', 'deleted',
                            'to_status', NULL, 'version', d.version), ts
    FROM done d;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION memory_sweep_expire(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_sweep_retire(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_sweep_purge(integer) FROM PUBLIC;
ALTER FUNCTION memory_sweep_expire(integer) OWNER TO memory_sweep_definer;
ALTER FUNCTION memory_sweep_retire(integer) OWNER TO memory_sweep_definer;
ALTER FUNCTION memory_sweep_purge(integer) OWNER TO memory_sweep_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to the reconciler's login alone.
GRANT EXECUTE ON FUNCTION memory_sweep_expire(integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION memory_sweep_retire(integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION memory_sweep_purge(integer) TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM memory_sweep_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_sweep_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The read seam for one entry's history, in 0653's shape (audit_log_read): product code never reads audit_log directly. SECURITY INVOKER on
-- purpose: app_user already reads audit_log and memory_entries under their tenant row policies, so running as the caller keeps those policies the
-- one isolation control (a definer would bypass them and have to rebuild them). No account parameter: the tenant is the session's, so a caller
-- cannot name another one; an unset tenant or a suspended account returns no rows. The memory actions are fixed here. The history covers every
-- row connected to the asked id through supersedes_id, in both directions (an edit does not start a new history), plus the asked id itself, so
-- an entry the purge removed still has its history. Oldest first; p_limit is clamped to 1..500 (NULL means 500). Only app_user may execute it.
CREATE FUNCTION memory_history_read(p_entry_id uuid, p_limit integer DEFAULT 500)
RETURNS TABLE (created_at timestamptz, action text, actor text, payload jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE
  tenant AS (SELECT NULLIF(current_setting('app.account_id', true), '')::uuid AS id),
  -- UNION (not UNION ALL) in both walks: a chain cannot loop, and if a bad row ever made it, the walk still ends.
  up(id, sup) AS (
    SELECT m.id, m.supersedes_id FROM public.memory_entries m, tenant t WHERE m.id = p_entry_id AND m.account_id = t.id
    UNION
    SELECT m.id, m.supersedes_id FROM up u JOIN public.memory_entries m ON m.id = u.sup, tenant t WHERE m.account_id = t.id
  ),
  down(id) AS (
    SELECT m.id FROM public.memory_entries m, tenant t WHERE m.id = p_entry_id AND m.account_id = t.id
    UNION
    SELECT m.id FROM down d JOIN public.memory_entries m ON m.supersedes_id = d.id, tenant t WHERE m.account_id = t.id
  ),
  chain AS (SELECT u.id FROM up u UNION SELECT d.id FROM down d UNION SELECT p_entry_id)
  SELECT a.created_at, a.action, a.actor, a.payload
    FROM public.audit_log a, tenant t
   WHERE a.account_id = t.id
     AND a.action IN ('memory.proposed', 'memory.written', 'memory.approved', 'memory.rejected', 'memory.retired', 'memory.reverted',
                      'memory.edited', 'memory.deleted', 'memory.restored', 'memory.receipt_promoted', 'memory.expired', 'memory.purged')
     AND a.payload ->> 'entry_id' IN (SELECT c.id::text FROM chain c)
   ORDER BY a.created_at, a.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500)
$$;
REVOKE ALL ON FUNCTION memory_history_read(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_history_read(uuid, integer) TO app_user;
-- No index for this read yet: it filters on the account index plus a jsonb key, fine at today's size. An expression index on the shared audit
-- table would block its writes while it builds inside this transaction, so it belongs in a separate no-transaction (CONCURRENTLY) migration if
-- this read ever becomes hot.

-- The reconcile job that calls them, once a day on the reconciler's own cadence (a job with no row is never due). Safe to re-run.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('memory_sweep', 86400) ON CONFLICT (name) DO NOTHING;
