-- ENGINE-IN-CLOUD EB-9a: receipts for the engine's three decisions (spawn an agent, merge a pull request, mark a Spec ready), and a
-- person's answer to one that was asked.
--
-- What:
--   1. engine_decisions: one row per (repo, decision type, request key). The engine asks the cloud before it acts; the first ask writes
--      the row and every later ask with the same key reads it back (idempotent). `subject` is a closed object of ids and enums, never
--      text (engine_decision_subject_ok). `disposition` is act, announce or ask. A row that was asked stays `ask`; the answer lives in
--      engine_decision_answers, so what a reader sees is derived from two append-only rows and never a stamp that could be edited.
--      `answered` and `answered_by` on the receipt itself are set only when a person's own request_spawn command covered the decision.
--   2. engine_decision_answers: at most one answer per decision, written by a signed-in owner or admin (RLS checks the role and that
--      the writer is the session's own person), and only for a decision that was asked.
--
-- Who writes: a verified runner (app.runner_id, which only the runner middleware sets, naming a live runner of the same account) inserts
-- receipts; a signed-in owner or admin inserts answers. Neither table has UPDATE or DELETE for app_user: an answer is final, and a
-- receipt is a record. Removing a repo deletes both through the foreign keys.
--
-- Halt (EB-11a) adds a BEFORE INSERT trigger on engine_decisions that raises HX409; nothing here reads a halt table, so this migration
-- stands alone and merges before it.
--
-- Rollback (expand/contract): nothing reads either table until the route is deployed; a later migration may drop them.
--
-- Numbered 1030 by the Team Lead for the bridge milestone: it merges after 1026 to 1029. Re-check against main right before merging.

CREATE OR REPLACE FUNCTION engine_decision_subject_ok(s jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_typeof(s) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(s) AS k WHERE k NOT IN ('discussion', 'pr', 'role', 'head_sha', 'tag'))
    AND (NOT s ? 'discussion' OR (jsonb_typeof(s -> 'discussion') = 'number' AND (s ->> 'discussion') ~ '^[1-9][0-9]{0,9}$'))
    AND (NOT s ? 'pr' OR (jsonb_typeof(s -> 'pr') = 'number' AND (s ->> 'pr') ~ '^[1-9][0-9]{0,9}$'))
    AND (NOT s ? 'role' OR (jsonb_typeof(s -> 'role') = 'string' AND (s ->> 'role') IN
      ('executor', 'code-reviewer', 'security-reviewer', 'acceptance-tester', 'browser-tester', 'project-manager', 'technical-architect',
       'product-owner', 'cost-analyst', 'performance-expert', 'security-expert', 'other')))
    AND (NOT s ? 'head_sha' OR (jsonb_typeof(s -> 'head_sha') = 'string' AND (s ->> 'head_sha') ~ '^[0-9a-f]{40}$'))
    AND (NOT s ? 'tag' OR (jsonb_typeof(s -> 'tag') = 'string' AND (s ->> 'tag') IN ('feature', 'critical', 'small', 'bug', 'doc', 'process', 'other')));
$$;

REVOKE ALL ON FUNCTION engine_decision_subject_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_decision_subject_ok(jsonb) TO app_user;

CREATE TABLE engine_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id            uuid NOT NULL,
  decision_type      text NOT NULL CHECK (decision_type IN ('engine_spawn', 'engine_merge', 'engine_spec_ready')),
  request_key        text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9:_-]{1,128}$'),
  subject            jsonb NOT NULL CHECK (engine_decision_subject_ok(subject)),
  disposition        text NOT NULL CHECK (disposition IN ('act', 'announce', 'ask')),
  catalogue_version  integer NOT NULL CHECK (catalogue_version >= 11),
  -- Where the dial came from: a preset name, 'override' for a hand-set dial, or 'default' for no row.
  preset             text NOT NULL CHECK (preset IN ('cautious', 'balanced', 'autonomous', 'override', 'default')),
  -- The catalogue entry that decided instead of this decision's own (a Feature or Critical Spec resolves through start_parent_item).
  resolved_via       text CHECK (resolved_via IS NULL OR resolved_via = 'start_parent_item'),
  -- Set only when a person's own request_spawn command covered the decision: their click is the decision.
  answered_by        uuid REFERENCES users (id),
  answered           text CHECK (answered IS NULL OR answered = 'approve'),
  command_id         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, repo_id, decision_type, request_key),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CONSTRAINT engine_decisions_answered_pair CHECK ((answered IS NULL) = (answered_by IS NULL)),
  CONSTRAINT engine_decisions_answered_by_command CHECK (answered IS NULL OR (command_id IS NOT NULL AND disposition = 'act' AND decision_type = 'engine_spawn')),
  CONSTRAINT engine_decisions_via_spec_ready CHECK (resolved_via IS NULL OR decision_type = 'engine_spec_ready')
);

-- One click, one start: a request_spawn command covers a single receipt.
CREATE UNIQUE INDEX engine_decisions_command_once_idx ON engine_decisions (account_id, command_id) WHERE answered IS NOT NULL;
CREATE INDEX engine_decisions_repo_created_idx ON engine_decisions (account_id, repo_id, created_at DESC);

CREATE TABLE engine_decision_answers (
  account_id    uuid NOT NULL,
  decision_id   uuid NOT NULL,
  choice        text NOT NULL CHECK (choice IN ('approve', 'decline')),
  answered_by   uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, decision_id),
  FOREIGN KEY (account_id, decision_id) REFERENCES engine_decisions (account_id, id) ON DELETE CASCADE
);

ALTER TABLE engine_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE engine_decision_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_decision_answers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON engine_decisions FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- A receipt is written only inside a verified runner's session (app.runner_id), for that runner's own account. The policy does not look
-- at who a receipt is answered by or which command covers it: the table's checks tie a person's name to a command id, and the decide
-- route (the only writer in a runner session) checks that the command's issuer is that person.
CREATE POLICY runner_insert ON engine_decisions FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM runners r
      WHERE r.id::text = lower(COALESCE(current_setting('app.runner_id', true), ''))
        AND r.account_id = engine_decisions.account_id
        AND r.revoked_at IS NULL
    )
  );

CREATE POLICY tenant_isolation_select ON engine_decision_answers FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- An answer is written by an owner or admin of the account, in their own name, for a decision that was asked, and never inside a runner
-- session: the decide route borrows the runner's registrant as app.user_id for the audit write, so a runner transaction must not be
-- able to answer as that person.
CREATE POLICY owner_admin_insert ON engine_decision_answers FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND COALESCE(current_setting('app.runner_id', true), '') = ''
    AND answered_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = engine_decision_answers.account_id AND m.user_id = engine_decision_answers.answered_by AND m.role IN ('owner', 'admin')
    )
    AND EXISTS (
      SELECT 1 FROM engine_decisions d
      WHERE d.account_id = engine_decision_answers.account_id AND d.id = engine_decision_answers.decision_id AND d.disposition = 'ask'
    )
  );

REVOKE ALL ON engine_decisions FROM PUBLIC;
REVOKE ALL ON engine_decision_answers FROM PUBLIC;
GRANT SELECT, INSERT ON engine_decisions TO app_user;
GRANT SELECT, INSERT ON engine_decision_answers TO app_user;
