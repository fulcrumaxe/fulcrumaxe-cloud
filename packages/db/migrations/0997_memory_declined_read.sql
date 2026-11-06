-- D#601 MEM-10: the read the auto-approve look-back uses to find the texts a person said no to.
--
-- The intake looked back over the 400 most recently updated rejected, retired, deleted or replaced entries of a repository. The retirement sweep
-- (0900) retires approved entries nobody used for 90 days, and those rows shared that window, so in an active repository enough sweep rows could push
-- an older person's no out of it. The window also only held repository and work-item entries, so a no recorded at role or account scope was never seen.
--
-- memory_declined_read returns the bodies of the entries a person declined, newest first, and nothing a time sweep retired: a retired entry counts only
-- when its latest `memory.retired` audit row was not written by the sweep (a retire with no audit row counts, so the look-back fails toward a person).
-- The latest row of every entry comes from one pass over the tenant's retire rows (a CTE), not a lookup per retired entry.
-- Scopes: the repository's own entries and its work items' entries, every account-scope entry, and the role-scope entries of p_role. The window of
-- p_limit rows (1 to 400, NULL means 400) now holds person decisions only.
--
-- SECURITY INVOKER on purpose, in 0900's memory_history_read shape: app_user already reads memory_entries, work_items and audit_log under the tenant row
-- policies, so running as the caller keeps those policies the one isolation control. The tenant is the session's, there is no account parameter.
-- Expand-only: one function, no definer role, owner and grants are the migrator's and app_user's EXECUTE alone. Numbered after main's highest (0996).

CREATE FUNCTION memory_declined_read(p_repo_ref text, p_repo_id uuid, p_role text, p_limit integer DEFAULT 400)
RETURNS TABLE (body text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH latest_retire AS (
    -- One pass over the tenant's retire rows: the newest `memory.retired` row of each entry, and who wrote it.
    SELECT DISTINCT ON (a.payload ->> 'entry_id') a.payload ->> 'entry_id' AS entry_id, a.actor
      FROM public.audit_log a
     WHERE a.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
       AND a.action = 'memory.retired'
     ORDER BY a.payload ->> 'entry_id', a.created_at DESC, a.id DESC
  )
  SELECT e.body
    FROM public.memory_entries e
    LEFT JOIN latest_retire l ON l.entry_id = e.id::text
   WHERE e.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
     AND (
          e.status IN ('rejected', 'deleted', 'superseded')
       OR (e.status = 'retired' AND COALESCE(l.actor, '') <> 'system:memory_sweep')
     )
     AND (
          (e.scope = 'repo' AND e.scope_ref = p_repo_ref)
       OR (e.scope = 'item' AND e.scope_ref IN (SELECT w.id::text FROM public.work_items w WHERE w.account_id = e.account_id AND w.repo_id = p_repo_id))
       OR e.scope = 'account'
       OR (e.scope = 'role' AND e.scope_ref = p_role)
     )
   ORDER BY e.updated_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 400), 1), 400)
$$;
REVOKE ALL ON FUNCTION memory_declined_read(text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_declined_read(text, uuid, text, integer) TO app_user;
