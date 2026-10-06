-- D#45 S1: work_items.stage, work_item_transitions, run start/end stamps.
--
-- Numbering: main's newest migration is 0608_work_items_provenance_vocabulary.sql
-- (D#94 R1). #119 (and its stale sibling #114) already claim 0609 for
-- 0609_revoked_sessions.sql, so this file takes 0610. Re-checked with
-- packages/db/scripts/check-migration-order.sh --base origin/main at build
-- time (see the PR body for its output); renumber above main's newest again
-- at rebase if main has moved.
--
-- No #92 INHERIT/ownership bracket is needed anywhere in this file: every
-- function and trigger created below is owned by the migration role itself
-- (plain LANGUAGE plpgsql, no SECURITY DEFINER, never transferred to
-- platform_ops) -- the same shape docs/ops/hosted-postgres.md calls out for
-- model_connections_guard_write() as NOT needing the bracket. The bracket
-- rule applies only to a `platform_ops`-owned object; nothing here is one.

-- ---------------------------------------------------------------------
-- 1. work_items.stage
-- ---------------------------------------------------------------------
ALTER TABLE work_items
  ADD COLUMN stage text NOT NULL DEFAULT 'triaged'
  CONSTRAINT work_items_stage_check CHECK (stage IN (
    'triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened',
    'changes_requested', 'review_passed', 'needs_human', 'merged',
    'closed_unmerged', 'closed'
  ));

-- ---------------------------------------------------------------------
-- 2. work_item_transitions
-- ---------------------------------------------------------------------
CREATE TABLE work_item_transitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  from_stage   text NOT NULL CONSTRAINT work_item_transitions_from_stage_check CHECK (from_stage IN (
                 'triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened',
                 'changes_requested', 'review_passed', 'needs_human', 'merged',
                 'closed_unmerged', 'closed'
               )),
  to_stage     text NOT NULL CONSTRAINT work_item_transitions_to_stage_check CHECK (to_stage IN (
                 'triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened',
                 'changes_requested', 'review_passed', 'needs_human', 'merged',
                 'closed_unmerged', 'closed'
               )),
  reviewer     text NULL CONSTRAINT work_item_transitions_reviewer_check
                 CHECK (reviewer IN ('code', 'security', 'acceptance')),
  at           timestamptz NOT NULL,
  source       text NOT NULL CONSTRAINT work_item_transitions_source_check
                 CHECK (source IN ('webhook', 'control_plane')),
  source_ref   text NOT NULL CONSTRAINT work_item_transitions_source_ref_length_check
                 CHECK (length(source_ref) BETWEEN 1 AND 200),
  run_id       uuid NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Spec: "(to_stage IN ('changes_requested','review_passed')) = (reviewer IS NOT NULL)".
  CONSTRAINT work_item_transitions_reviewer_required_check CHECK (
    (to_stage IN ('changes_requested', 'review_passed')) = (reviewer IS NOT NULL)
  ),
  -- Spec: "at <= created_at + interval '5 minutes'". created_at is always
  -- overwritten to the real now() by the BEFORE INSERT trigger below
  -- (section 3), for every role -- this CHECK is what actually rejects a
  -- forward-dated `at`, since a client cannot move created_at out of the
  -- way to defeat it.
  CONSTRAINT work_item_transitions_at_window_check CHECK (at <= created_at + interval '5 minutes'),

  UNIQUE (account_id, work_item_id, to_stage, source_ref),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id)
);

CREATE INDEX idx_work_item_transitions_account_work_item_at
  ON work_item_transitions (account_id, work_item_id, at);

-- ---------------------------------------------------------------------
-- 3. No forward-dated stamps: BEFORE INSERT trigger sets created_at =
--    now() for every role, unconditionally -- the CHECK above then does
--    the actual rejecting.
-- ---------------------------------------------------------------------
CREATE FUNCTION work_item_transitions_set_created_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_item_transitions_set_created_at
  BEFORE INSERT ON work_item_transitions
  FOR EACH ROW EXECUTE FUNCTION work_item_transitions_set_created_at();

-- ---------------------------------------------------------------------
-- 4. Tenancy and grants: identical tenant_isolation shape to work_items
--    (0001_core.sql:919-927). SELECT + INSERT only -- work_item_transitions
--    is an append-only history, same reasoning as ledger/audit_log
--    (0001_core.sql's own security-fix-round comments on those tables): no
--    UPDATE, no DELETE, and no grant at all to partner_user/platform_ops.
-- ---------------------------------------------------------------------
ALTER TABLE work_item_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_item_transitions TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON work_item_transitions TO app_user;

-- ---------------------------------------------------------------------
-- 5. agent_runs run start/end stamps.
--
--    started_at is set exactly once, the first time an UPDATE moves
--    status to 'running' (OLD.started_at IS NULL); every later write,
--    including one that tries to set it explicitly, leaves it unchanged.
--
--    ended_at is set exactly once, the first time NEW.status is one of
--    the terminal `agent_runs.status` values -- the keys of
--    packages/runner/src/statusTransitions.ts's RUN_STATUS_TRANSITIONS
--    whose transition list is empty: 'refused_spend', 'succeeded',
--    'failed', 'timed_out', 'killed_spend', 'cancelled'. That table lives
--    in TypeScript (H09's file scope is packages/runner/** only, per that
--    file's own header -- no migration file), so this terminal set is
--    reproduced here by literal value; run-times-trigger.test.ts imports
--    RUN_STATUS_TRANSITIONS directly and checks every key against this
--    trigger's real behavior, so a drift between the two would fail that
--    test rather than pass silently.
--
--    Both columns are forced NULL on INSERT regardless of any
--    client-supplied value, matching started_at/ended_at not yet having
--    happened for a freshly created run -- except ended_at, which an
--    INSERT landing directly in a terminal status (e.g. 'refused_spend')
--    stamps immediately, since no later UPDATE will ever fire for it.
-- ---------------------------------------------------------------------
ALTER TABLE agent_runs ADD COLUMN started_at timestamptz NULL;
ALTER TABLE agent_runs ADD COLUMN ended_at timestamptz NULL;

CREATE FUNCTION agent_runs_stamp_times() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.started_at := NULL;
    IF NEW.status IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled') THEN
      NEW.ended_at := now();
    ELSE
      NEW.ended_at := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.started_at IS NOT NULL THEN
      NEW.started_at := OLD.started_at;
    ELSIF NEW.status = 'running' THEN
      NEW.started_at := now();
    ELSE
      NEW.started_at := OLD.started_at;
    END IF;

    IF OLD.ended_at IS NOT NULL THEN
      NEW.ended_at := OLD.ended_at;
    ELSIF NEW.status IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled') THEN
      NEW.ended_at := now();
    ELSE
      NEW.ended_at := OLD.ended_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_stamp_times
  BEFORE INSERT OR UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_stamp_times();
