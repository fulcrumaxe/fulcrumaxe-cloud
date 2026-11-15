-- D#? Issue #757 PR "record": a person's confirmation that they checked the criteria a reviewer said it could not verify
-- (`reviewer_unverifiable`, see unverifiable.ts), stored so the merge gate and the round decision can later clear just
-- that role (a later PR) instead of parking the item forever (`verdict_not_pass_<role>` never clears for an envelope
-- whose verdict is the string `unverifiable`, and the person is today told to merge or close on GitHub by hand).
--
-- One row per (work item, head, role): who confirmed it, what they confirmed (copied server-side from the reviewer's
-- own stored envelope, never from the request), and when. The row is bound to the exact head it was taken on
-- (`UNIQUE (account_id, work_item_id, head_sha, role)`), so a later push to the pull request makes it inert by
-- construction: a verification of an older head clears nothing on a newer one. Not revocable (no DELETE grant); Request
-- changes and Close remain the only way out of a stop this does not clear.
--
-- Tenant-scoped exactly as `head_refreshes` (0824): RLS confined to `app.account_id`, SELECT and INSERT only for
-- app_user (no UPDATE, no DELETE -- the record does not change once written).
--
-- Numbered above the highest migration claimed on the code plane (1009). Re-check against main right before merging.

-- Every element of `criteria` is a plain object with an integer `index` (into the reviewer's own stored list) and a
-- non-empty `criterion` string of at most MAX_UNVERIFIABLE_CHARS (unverifiable.ts), at most MAX_UNVERIFIABLE of them
-- (unverifiable.ts) -- the same two bounds the reviewer's own envelope is held to, so a stored record can never be
-- larger than what a reviewer could have written in the first place.
CREATE FUNCTION work_item_criteria_verifications_criteria_ok(c jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(c) = 'array'
    AND jsonb_array_length(c) BETWEEN 1 AND 10
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(c) AS e
       WHERE jsonb_typeof(e) <> 'object'
          OR jsonb_typeof(e -> 'index') <> 'number'
          OR (e ->> 'index')::numeric <> trunc((e ->> 'index')::numeric)
          OR (e ->> 'index')::numeric < 0
          OR jsonb_typeof(e -> 'criterion') <> 'string'
          OR length(e ->> 'criterion') < 1
          OR length(e ->> 'criterion') > 400
    )
$$;

REVOKE ALL ON FUNCTION work_item_criteria_verifications_criteria_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work_item_criteria_verifications_criteria_ok(jsonb) TO app_user;

CREATE TABLE work_item_criteria_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  -- The exact head the reviewer's unverifiable run (and the person's confirmation) was taken on.
  head_sha     text NOT NULL CONSTRAINT work_item_criteria_verifications_head_check CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  role         text NOT NULL CONSTRAINT work_item_criteria_verifications_role_check CHECK (role IN ('code-reviewer', 'security-reviewer', 'acceptance-tester', 'debater')),
  run_id       uuid NOT NULL,
  -- The confirmed items, copied server-side from that run's own stored envelope: [{"index": n, "criterion": "..."}].
  criteria     jsonb NOT NULL CONSTRAINT work_item_criteria_verifications_criteria_check CHECK (work_item_criteria_verifications_criteria_ok(criteria)),
  verified_by  uuid NOT NULL REFERENCES users (id),
  verified_at  timestamptz NOT NULL DEFAULT now(),

  -- One confirmation per role, per head: a second press for the same item and head is refused at the database, not
  -- only by the route (D#757 criterion 8).
  UNIQUE (account_id, work_item_id, head_sha, role),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id)
);

-- The card's read: every verified role of one item's head, in one indexed lookup.
CREATE INDEX idx_work_item_criteria_verifications_item ON work_item_criteria_verifications (account_id, work_item_id, head_sha);

-- verified_at is always the database's own clock, whatever an INSERT says.
CREATE FUNCTION work_item_criteria_verifications_set_verified_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.verified_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_item_criteria_verifications_set_verified_at
  BEFORE INSERT ON work_item_criteria_verifications
  FOR EACH ROW EXECUTE FUNCTION work_item_criteria_verifications_set_verified_at();

ALTER TABLE work_item_criteria_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_criteria_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_item_criteria_verifications TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- No UPDATE, no DELETE: the record is not revocable and does not change once written.
GRANT SELECT, INSERT ON work_item_criteria_verifications TO app_user;
