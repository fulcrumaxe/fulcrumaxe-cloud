-- D#483 S4-f2: the docs-and-code analysis queue, the title normaliser, the analyst's refs on a proposal, and the list a sweep starts from.
--
-- An analysis reads a repository's default branch (docs and code) and proposes ideas that are not yet issues. This migration holds only the data
-- side; nothing in it starts a run:
--
--   * discovery_analyses: one row per repository and default-branch head, UNIQUE (repo_id, head_sha). The key is the idempotency rule and "only
--     when the branch changed" in one: an unchanged head can never queue a second analysis. It has the 0859 shape: forced row security,
--     app_user SELECT, a four-column INSERT that always starts `queued`, a column-scoped UPDATE, a guard trigger that only moves forward,
--     and no DELETE. State, failure code, counts and attempts are stamps (what one run saw and did at one sha).
--   * proposals.analysis_refs: the analyst's `path:start-end` refs, at most 10. The verifier reads them as source lines; they are not evidence.
--     Per-element rules (the 0871 path rule, a line range of 1 to 9 digits each) run in one CHECK through a pure function that tests each element alone.
--     plan_importer may write the column; nobody else gains anything.
--   * proposal_title_norm(text): lowercase, anything but letters, digits and spaces removed, whitespace collapsed, trimmed. IMMUTABLE, with a
--     functional index on (repo_id, norm). It is the only copy of the rule: the `src:` key and every match are computed from it in SQL.
--   * discovery_analysis_list_due(): the cross-account list of analyses waiting to start, owned by its own NOLOGIN role
--     (the 0889 bracket). It returns ids only and writes nothing.
--
-- Expand-only: a table, a column with no default, a function and a role. 0723, 0753, 0755, 0758, 0839 and 0859 are not edited.
-- Numbered above main's highest (0947) and the numbers open work holds (0948, 0949); re-checked at open and before merge.

-- 1. The queue.
CREATE TABLE discovery_analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  head_sha    text NOT NULL CONSTRAINT discovery_analyses_head_sha_check CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  trigger     text NOT NULL DEFAULT 'sweep' CONSTRAINT discovery_analyses_trigger_check CHECK (trigger = 'sweep'),
  state       text NOT NULL DEFAULT 'queued' CONSTRAINT discovery_analyses_state_check CHECK (state IN ('queued', 'running', 'succeeded', 'skipped', 'failed')),
  -- The skip reason or failure code. A queued row may carry the reason it is being held (`daily_cap`); a skipped or failed row must.
  skip_reason text CONSTRAINT discovery_analyses_skip_reason_check CHECK (skip_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  attempts    integer NOT NULL DEFAULT 0 CONSTRAINT discovery_analyses_attempts_check CHECK (attempts BETWEEN 0 AND 3),
  run_id      uuid,
  counts      jsonb CONSTRAINT discovery_analyses_counts_check CHECK (jsonb_typeof(counts) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  CONSTRAINT discovery_analyses_once_key UNIQUE (repo_id, head_sha),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id),
  CONSTRAINT discovery_analyses_reason_when_ended CHECK (state NOT IN ('skipped', 'failed') OR skip_reason IS NOT NULL),
  CONSTRAINT discovery_analyses_finished_iff_ended CHECK ((state IN ('succeeded', 'skipped', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX discovery_analyses_waiting ON discovery_analyses (created_at, id) WHERE state IN ('queued', 'running');

ALTER TABLE discovery_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discovery_analyses TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

GRANT SELECT ON discovery_analyses TO app_user;
GRANT INSERT (account_id, repo_id, head_sha, trigger) ON discovery_analyses TO app_user;
GRANT UPDATE (state, skip_reason, attempts, run_id, counts, started_at, finished_at) ON discovery_analyses TO app_user;

-- Legal moves only: a row starts queued; queued moves to running, skipped or failed; running moves to succeeded, skipped or failed; an ended
-- row never changes (except its run name going to NULL when that run is deleted); identity never changes; attempts never go down. A queued or running row may change in place (attempts, run, hold reason).
CREATE FUNCTION discovery_analyses_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'discovery_analyses: an analysis is queued first' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- The one change an ended row may take: its run is deleted and the foreign key's ON DELETE SET NULL (run_id) clears the name. Nothing else differs.
  IF OLD.state IN ('succeeded', 'skipped', 'failed') AND OLD.run_id IS NOT NULL AND NEW.run_id IS NULL
     AND (NEW.id, NEW.account_id, NEW.repo_id, NEW.head_sha, NEW.trigger, NEW.created_at, NEW.state, NEW.skip_reason, NEW.attempts, NEW.counts, NEW.started_at, NEW.finished_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.account_id, OLD.repo_id, OLD.head_sha, OLD.trigger, OLD.created_at, OLD.state, OLD.skip_reason, OLD.attempts, OLD.counts, OLD.started_at, OLD.finished_at) THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.repo_id, NEW.head_sha, NEW.trigger, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.repo_id, OLD.head_sha, OLD.trigger, OLD.created_at)
     OR NEW.attempts < OLD.attempts
     OR OLD.state IN ('succeeded', 'skipped', 'failed')
     OR NOT (NEW.state = OLD.state
          OR (OLD.state = 'queued' AND NEW.state IN ('running', 'skipped', 'failed'))
          OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'skipped', 'failed'))) THEN
    RAISE EXCEPTION 'discovery_analyses: illegal change from %', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION discovery_analyses_write_guard() FROM PUBLIC;
CREATE TRIGGER discovery_analyses_write_guard BEFORE INSERT OR UPDATE ON discovery_analyses
  FOR EACH ROW EXECUTE FUNCTION discovery_analyses_write_guard();

-- 2. The analyst's refs. One CHECK: NULL, or 1 to 10 elements that each pass `proposal_analysis_refs_ok`, which tests every element on its own
-- (no join of the elements, so one element can never carry several refs or slip past the size cap): not NULL, `path:start-end` with each line
-- number 1 to 9 digits, a path of 1 to 240 characters that is the 0871 path rule (no leading slash, `~`, drive letter, backslash, control
-- character, NEL, U+2028 or U+2029, and no empty, `.` or `..` segment, which includes a trailing slash). It reads no table. The check runs for whichever
-- role writes a proposal row that has refs, so the roles that write proposals hold EXECUTE (as for proposal_title_norm below) and PUBLIC does not.
CREATE FUNCTION proposal_analysis_refs_ok(p_refs text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT cardinality(p_refs) BETWEEN 1 AND 10
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_refs) AS u(e), LATERAL (SELECT substring(u.e from '^(.*):[0-9]{1,9}-[0-9]{1,9}$') AS path) x
        WHERE u.e IS NULL OR x.path IS NULL OR char_length(x.path) NOT BETWEEN 1 AND 240
           OR x.path ~ '[[:cntrl:]]' OR x.path ~ ('[' || chr(133) || chr(8232) || chr(8233) || ']') OR strpos(x.path, chr(92)) > 0
           OR x.path ~ '^/' OR x.path ~ '^~(/|$)' OR x.path ~ '^[A-Za-z]:/' OR x.path ~ '(^|/)(\.|\.\.)?(/|$)')
$$;
REVOKE ALL ON FUNCTION proposal_analysis_refs_ok(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_analysis_refs_ok(text[]) TO plan_importer, platform_ops, proposal_follower, proposal_verification_definer, dial_start_definer;

ALTER TABLE proposals
  ADD COLUMN analysis_refs text[]
    CONSTRAINT proposals_analysis_refs_check CHECK (analysis_refs IS NULL OR proposal_analysis_refs_ok(analysis_refs));
GRANT INSERT (analysis_refs), UPDATE (analysis_refs) ON proposals TO plan_importer;

-- 3. The one normaliser. Named roles only (a PUBLIC-executable function would widen every login's reach); the roles that write proposals hold it
-- because index maintenance evaluates it for them.
CREATE FUNCTION proposal_title_norm(p_title text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT btrim(regexp_replace(regexp_replace(lower(p_title), '[^[:alnum:][:space:]]', '', 'g'), '[[:space:]]+', ' ', 'g'))
$$;
REVOKE ALL ON FUNCTION proposal_title_norm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_title_norm(text) TO plan_importer, platform_ops, proposal_follower, proposal_verification_definer, dial_start_definer;
CREATE INDEX proposals_title_norm ON proposals (repo_id, proposal_title_norm(title));

-- 4. The list of analyses waiting to start, in its own role (the 0889 bracket): NOLOGIN, no members, column grants for exactly what the body
-- reads, one row policy per table for this role alone, a pinned search_path, EXECUTE for the run-writer login and nobody else.
DO $$
DECLARE
  n text := 'discovery_analysis_lister';
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

GRANT USAGE ON SCHEMA public TO discovery_analysis_lister;
GRANT SELECT (id, account_id, repo_id, state, created_at) ON discovery_analyses TO discovery_analysis_lister;
GRANT SELECT (id, account_id, execution_mode, installation_id, product) ON repos TO discovery_analysis_lister;
GRANT SELECT (id, deleted_at) ON accounts TO discovery_analysis_lister;
CREATE POLICY discovery_analysis_lister_select ON discovery_analyses FOR SELECT TO discovery_analysis_lister USING (state IN ('queued', 'running'));
CREATE POLICY discovery_analysis_lister_select ON repos FOR SELECT TO discovery_analysis_lister
  USING (execution_mode = 'sandbox' AND installation_id IS NOT NULL AND product = 'team');
CREATE POLICY discovery_analysis_lister_select ON accounts FOR SELECT TO discovery_analysis_lister USING (deleted_at IS NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discovery_analysis_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discovery_analysis_lister; cannot ALTER FUNCTION ... OWNER TO discovery_analysis_lister';
    END IF;
    GRANT discovery_analysis_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO discovery_analysis_lister;

-- Oldest first, at most 5 per account in one call, so one account cannot hold every place. A running analysis stays listed so the pass finds its run.
CREATE FUNCTION discovery_analysis_list_due(p_limit int)
RETURNS TABLE (account_id uuid, analysis_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'discovery_analysis_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'discovery_analysis_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT x.account_id, x.id, x.created_at,
             row_number() OVER (PARTITION BY x.account_id ORDER BY x.created_at, x.id) AS rn
        FROM public.discovery_analyses x
        JOIN public.accounts a ON a.id = x.account_id AND a.deleted_at IS NULL
        JOIN public.repos r ON r.account_id = x.account_id AND r.id = x.repo_id
                           AND r.execution_mode = 'sandbox' AND r.installation_id IS NOT NULL AND r.product = 'team'
       WHERE x.state IN ('queued', 'running')
    ) d
   WHERE d.rn <= 5
   ORDER BY d.created_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION discovery_analysis_list_due(int) FROM PUBLIC;
ALTER FUNCTION discovery_analysis_list_due(int) OWNER TO discovery_analysis_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0874, 0886 and 0889 do.
GRANT EXECUTE ON FUNCTION discovery_analysis_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM discovery_analysis_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE discovery_analysis_lister FROM CURRENT_USER;
  END IF;
END
$$;
