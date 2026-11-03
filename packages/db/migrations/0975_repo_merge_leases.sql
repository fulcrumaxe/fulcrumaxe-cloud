-- D#483 S5-j2a1: the per-repository merge lease.
--
-- A direct merge (the workflow's merge gate) and the merge queue's slot must not run on one repository at the same time, or the order
-- check that guards the queue is not the check that guards the direct merge. The gate takes a row here before it reads anything for
-- the merge decision and frees it on every exit; the queue's `takeSlot` skips while a live row exists, and the gate refuses to take
-- one while an entry of the repository is `in_flight`. Both sides run their check under `pg_advisory_xact_lock` in a short
-- transaction, so the two exclusions are one atomic rule.
--
-- A row past `lease_until` is dead: the next taker overwrites it. No job and no cron cleans up. `kind` is `direct` (a gate run) or
-- `order` (a runner merge order, a later row). Expand-only: a new table, nothing existing changes, no backfill. The number is the
-- next free one above main and every open pull request; the Team Lead re-checks it at merge.
CREATE TABLE repo_merge_leases (
  account_id  uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid        NOT NULL,
  holder      text        NOT NULL CONSTRAINT repo_merge_leases_holder_check CHECK (length(holder) BETWEEN 1 AND 100),
  kind        text        NOT NULL CONSTRAINT repo_merge_leases_kind_check CHECK (kind IN ('direct', 'order')),
  lease_until timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

ALTER TABLE repo_merge_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_merge_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repo_merge_leases TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON repo_merge_leases FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_merge_leases TO app_user;
