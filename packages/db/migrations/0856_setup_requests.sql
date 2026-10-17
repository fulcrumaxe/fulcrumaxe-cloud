-- D#598 P8a: setup requests, the first-class "I need a person to do this" step for a work item.
--
-- A request names one fixed KIND of step (an environment variable on a project, a GitHub App that is not installed on a repo, public/private
-- drift, a parent pull request that was closed, a branch a person pushed to, a plan file missing from the overlay paths), the TARGET it is
-- about, and a plain-text REASON. There is no value column anywhere: a request can name an environment variable, never carry its value, and the
-- only link it may hold is a provider page on a fixed host list (github.com or vercel.com), enforced here and again in the API.
--
-- Two origins, because the Spec asks for two different shapes of truth:
--   agent    stamped once. The kind, target, reason and link are frozen for every role; only the state moves.
--   derived  recomputed from current state (public/private drift, re-checked after each merge). Target and reason may be refreshed while the
--            request is open; when the condition clears the request is closed as `condition_cleared`.
--
-- States: open -> done | withdrawn; done -> open only for a request that has an automatic check (a check that fails after "mark done" puts the
-- request back, with the check's reason). withdrawn is final. A request holds its work item paused while it is open; a withdrawn one keeps
-- the item paused until the next person's advance (read by packages/core/src/setup-requests/store.ts, nothing is stamped on the item).
--
-- Who may write: app_user holds SELECT and INSERT, and UPDATE on the state columns only; there is no DELETE. A request a person creates, marks
-- done or withdraws must carry that person's own user id and that user must be an owner or admin of the account. A system transition (a check
-- passing, a derived request refreshed or cleared) carries no person. The tenant is always app.account_id; no row can name another account.
--
-- Expand-only: a new table and its guards, nothing existing is dropped, renamed or narrowed. Numbered above the highest migration on the code
-- plane and the open PRs' claims; re-checked right before merge. Privilege bracket copied from 0849.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE setup_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id       uuid NOT NULL,
  work_item_id  uuid,
  origin        text NOT NULL CONSTRAINT setup_requests_origin_check CHECK (origin IN ('agent', 'derived')),
  kind          text NOT NULL CONSTRAINT setup_requests_kind_check CHECK (kind IN (
                  'env_var', 'app_not_installed', 'parity_drift', 'parent_pr_closed', 'branch_pushed_by_person', 'overlay_path_missing')),
  target        text NOT NULL CONSTRAINT setup_requests_target_check
                  CHECK (char_length(target) BETWEEN 1 AND 200 AND target !~ '[\u0001-\u001F\u007F]'),
  env_name      text CONSTRAINT setup_requests_env_name_check CHECK (env_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,99}$'),
  reason        text NOT NULL CONSTRAINT setup_requests_reason_check
                  CHECK (char_length(reason) BETWEEN 1 AND 1000 AND reason !~ '[\u0001-\u0008\u000B-\u001F\u007F]'),
  provider_url  text CONSTRAINT setup_requests_provider_url_check
                  CHECK (char_length(provider_url) <= 500 AND provider_url ~ '^https://(github\.com|vercel\.com)(/[A-Za-z0-9._~!$&''()*+,;=:@%/?#-]*)?$'),
  check_kind    text CONSTRAINT setup_requests_check_kind_check CHECK (check_kind IN ('env_var_present')),
  state         text NOT NULL DEFAULT 'open' CONSTRAINT setup_requests_state_check CHECK (state IN ('open', 'done', 'withdrawn')),
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolution    text CONSTRAINT setup_requests_resolution_check CHECK (resolution IN ('marked_done', 'check_passed', 'condition_cleared', 'withdrawn')),
  resolved_by   uuid REFERENCES users (id),
  resolved_at   timestamptz,
  check_reason  text CONSTRAINT setup_requests_check_reason_check CHECK (char_length(check_reason) BETWEEN 1 AND 300 AND check_reason !~ '[\u0001-\u001F\u007F]'),
  check_ran_at  timestamptz,
  CONSTRAINT setup_requests_env_shape CHECK ((kind = 'env_var') = (env_name IS NOT NULL)),
  CONSTRAINT setup_requests_check_shape CHECK (check_kind IS NULL OR kind = 'env_var'),
  CONSTRAINT setup_requests_origin_shape CHECK (
    (origin = 'derived' AND kind = 'parity_drift' AND created_by IS NULL AND check_kind IS NULL)
    OR (origin = 'agent' AND kind <> 'parity_drift' AND created_by IS NOT NULL)),
  CONSTRAINT setup_requests_resolution_shape CHECK (
    (state = 'open' AND resolution IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (state = 'done' AND resolution IN ('marked_done', 'check_passed', 'condition_cleared') AND resolved_at IS NOT NULL)
    OR (state = 'withdrawn' AND resolution = 'withdrawn' AND resolved_at IS NOT NULL)),
  CONSTRAINT setup_requests_resolver_shape CHECK ((resolution IN ('marked_done', 'withdrawn')) = (resolved_by IS NOT NULL)),
  CONSTRAINT setup_requests_resolution_origin CHECK (
    (resolution = 'check_passed') <= (check_kind IS NOT NULL) AND (resolution = 'condition_cleared') <= (origin = 'derived')),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE NO ACTION
);
CREATE INDEX idx_setup_requests_account_state ON setup_requests (account_id, state, created_at DESC);
CREATE INDEX idx_setup_requests_work_item ON setup_requests (account_id, work_item_id) WHERE work_item_id IS NOT NULL;
-- One open request per step: asking twice for the same thing is the same request.
CREATE UNIQUE INDEX uq_setup_requests_open ON setup_requests
  (account_id, repo_id, kind, target, COALESCE(env_name, ''), COALESCE(work_item_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'open';

-- Insert: the database's own clock for created_at, whatever the statement says.
CREATE FUNCTION setup_requests_stamp() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION setup_requests_stamp() FROM PUBLIC;
CREATE TRIGGER setup_requests_stamp BEFORE INSERT ON setup_requests FOR EACH ROW EXECUTE FUNCTION setup_requests_stamp();

-- Update, for every role including the owner: what was stamped stays stamped, and only the legal transitions happen.
CREATE FUNCTION setup_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.repo_id, NEW.work_item_id, NEW.origin, NEW.kind, NEW.env_name, NEW.provider_url, NEW.check_kind, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.repo_id, OLD.work_item_id, OLD.origin, OLD.kind, OLD.env_name, OLD.provider_url, OLD.check_kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'setup_requests_frozen: a request''s identity and stamped terms cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'withdrawn' THEN
    RAISE EXCEPTION 'setup_requests_terminal: a withdrawn request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.target, NEW.reason) IS DISTINCT FROM (OLD.target, OLD.reason)
     AND NOT (OLD.origin = 'derived' AND OLD.state = 'open' AND NEW.state = 'open') THEN
    RAISE EXCEPTION 'setup_requests_frozen: only an open derived request may be refreshed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'open' AND NEW.state IN ('done', 'withdrawn'))
         OR (OLD.state = 'done' AND NEW.state = 'open' AND OLD.check_kind IS NOT NULL AND NEW.check_reason IS NOT NULL)) THEN
      RAISE EXCEPTION 'setup_requests_illegal_transition: % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'open' THEN
      NEW.resolved_at := now();
    END IF;
  ELSIF (NEW.resolution, NEW.resolved_by, NEW.resolved_at) IS DISTINCT FROM (OLD.resolution, OLD.resolved_by, OLD.resolved_at) THEN
    RAISE EXCEPTION 'setup_requests_frozen: a resolution cannot change without a transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION setup_requests_guard() FROM PUBLIC;
CREATE TRIGGER setup_requests_guard BEFORE UPDATE ON setup_requests FOR EACH ROW EXECUTE FUNCTION setup_requests_guard();

ALTER TABLE setup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON setup_requests
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- A new request is open and unresolved. An agent-proposed one is stamped with the session's own owner or admin; a derived one has no person but
-- is written by a member of the account.
CREATE POLICY tenant_insert ON setup_requests
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND state = 'open'
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = setup_requests.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND (origin = 'derived' OR (m.role IN ('owner', 'admin') AND created_by = m.user_id))
    )
  );

-- A person's resolution (marked done, withdrawn) names that person and needs an owner or admin; a system one names nobody.
CREATE POLICY tenant_update ON setup_requests
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = setup_requests.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND (resolved_by IS NULL OR (m.role IN ('owner', 'admin') AND resolved_by = m.user_id))
    )
  );

GRANT SELECT, INSERT ON setup_requests TO app_user;
GRANT UPDATE (target, reason, state, resolution, resolved_by, resolved_at, check_reason, check_ran_at) ON setup_requests TO app_user;

-- Close the window opened above.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
