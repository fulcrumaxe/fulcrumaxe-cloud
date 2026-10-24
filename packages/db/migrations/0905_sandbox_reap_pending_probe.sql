-- D#6 RECON-REAP-VISIBILITY: lets the stall digest's login (platform_ops) tell that terminal-stage sandbox reap work is pending, with one
-- yes/no answer and no row.
--
-- Why. The lap rule (readLapTimes / checkStalls in @fx/reconcile) judges a job against its 15-minute cadence only while it "has work". For
-- sandbox_reap_terminal that was only "the last pass stopped on its budget". Work that never hit a budget (a finished item whose sandbox
-- is still waiting, and no pass ran) was invisible: the facts live in agent_runs, work_items, run_action_requests, spend_reservations and
-- sandbox_reaps, none of which platform_ops may read, so a reconcile job stuck with that backlog never counted as breaching.
--
-- Why a definer and not a column grant. "Pending" is not a column: it is the 0731 candidate rule (one account, no live run, no queued or
-- leased run action, every sharing work item terminal, no fresh claim, not reaped since the last run), which spans all five tables, and
-- sandbox_reaps must stay unreadable to platform_ops (0761). A grant would have given platform_ops five tables' columns and a copy of the
-- rule in TypeScript. This function reuses sandbox_reap_ex_state, the one the candidate list and the claim read, so the three cannot
-- disagree, and shows platform_ops a single boolean.
--
-- What it answers: true when a candidate exists that the terminal pass can delete (reason 'terminal'). A candidate whose compute settle is
-- still owed ('terminal_unsettled') is excluded: the pass may stop it but never deletes it, so it stays a candidate until the settle
-- finishes and counting it would keep the job "busy" with nothing the job can do. It returns one boolean and no name, id or count.
--
-- Only NEW work: the caller passes the time of the job's last full pass (reconcile_jobs.last_full_pass_at; NULL = never), and a candidate
-- counts only when one of its runs started after that. A candidate the last full pass already looked at and left in place (provider state
-- unknown, a stray inside its grace, a failed stop or delete closed as skipped) stays a candidate until a new run, and counting it would make
-- an undeletable sandbox look like a stuck job every idle window. A pass that keeps erroring never moves last_full_pass_at, so a real backlog
-- still counts. The argument is only a time, so a caller can narrow or widen the answer but learn nothing more than one boolean. Known gap:
-- a run that started before the last pass and finished after it is not seen here; the marker its finish sets wakes the pass that handles it.
--
-- Owner: sandbox_reaper (0731), which already holds exactly the column grants and row policies sandbox_reap_ex_state reads. EXECUTE for
-- platform_ops only. Expand-only: one function. Numbered above the highest migration on main (0904); re-check right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'sandbox_reaper'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on sandbox_reaper; cannot ALTER FUNCTION ... OWNER TO sandbox_reaper';
    END IF;
    GRANT sandbox_reaper TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_reaper;

CREATE FUNCTION sandbox_reap_terminal_pending(p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sandbox_reap_ex_state(NULL, NULL) s
     WHERE s.n_accounts = 1 AND NOT s.has_live AND NOT s.has_action
       AND s.n_items > 0 AND s.n_open = 0 AND NOT s.claimed AND NOT s.reaped_since AND NOT s.unsettled
       AND (p_since IS NULL OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.sandbox_name = s.sandbox_name AND r.created_at > p_since)))
$$;

REVOKE ALL ON FUNCTION sandbox_reap_terminal_pending(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_reap_terminal_pending(timestamptz) TO platform_ops;
ALTER FUNCTION sandbox_reap_terminal_pending(timestamptz) OWNER TO sandbox_reaper;

REVOKE CREATE ON SCHEMA public FROM sandbox_reaper;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_reaper FROM CURRENT_USER;
  END IF;
END
$$;
