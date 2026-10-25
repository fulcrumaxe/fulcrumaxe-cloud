-- D#6 PUBLIC-MERGE PR2a: the merge order, the cloud's record that a paired item's PUBLIC pull request is waiting for the item's own local runner to merge it.
--
-- For a repository in runner_local mode the cloud never merges and never reads contents. When the gate has cleared a paired item, it places ONE order here
-- instead of merging. The runner claims it, checks the content of the two commits itself (the shared change-set comparison), asks the cloud for a go, merges
-- with a credential the cloud issues for this order alone, and reports. This table holds only facts the cloud already has (the pushed record, two shas, the
-- digest of the pairing) and the order's progress. It holds no contents, no paths and no credential. `token_purpose` is a label for the kind of credential the
-- minting layer issues for the order; the schema does not depend on what that kind is.
--
--   state      pending -> claimed -> authorized -> merged
--                  \        \            \-> head_moved | failed
--                   \        \-> blocked | head_moved | superseded | failed
--                    \-> blocked (its pairing changed) | superseded | expired   (an open order past its deadline is expired from any open state)
--   Terminal states (merged, blocked, head_moved, superseded, failed, expired) never change again. A trigger enforces the table of moves.
--   lease      a claim leases the order to one runner for a while; `lease_generation` counts claims (a runner names it on every call), `attempts` is capped at 3.
--   one write  the write credential is issued at most once per order: `write_token_issued_at` is set once, with the move to authorized, and never cleared.
--   one open   at most one open order per work item; placing an order for new heads supersedes the open one in the same transaction (the store does that).
--
-- Tenant scoped like plane_pushes: account_id, RLS forced, the same policy, app_user may SELECT, INSERT and UPDATE; there is no DELETE.
-- Expand-only: one new table. Numbered above the highest migration on the code plane (0909); re-check before the pull request is opened and before merging.

CREATE TABLE plane_merge_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id          uuid NOT NULL,
  plane_push_id         uuid NOT NULL,
  -- The PRIVATE repo the item is built in.
  repo_id               uuid NOT NULL,
  -- Copied from the plane_pushes row when the order is placed, so the order stays readable on its own.
  code_repo             text NOT NULL
    CONSTRAINT plane_merge_orders_code_repo_check CHECK (
      code_repo ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9._-]{1,100}$'
      AND split_part(code_repo, '/', 2) NOT IN ('.', '..')),
  pr_number             integer NOT NULL CONSTRAINT plane_merge_orders_pr_check CHECK (pr_number > 0),
  expected_public_head  text NOT NULL CONSTRAINT plane_merge_orders_public_head_check CHECK (expected_public_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  reviewed_head         text NOT NULL CONSTRAINT plane_merge_orders_reviewed_head_check CHECK (reviewed_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  pairing_digest        text NOT NULL CONSTRAINT plane_merge_orders_digest_check CHECK (pairing_digest ~ '^[0-9a-f]{64}$'),
  state                 text NOT NULL DEFAULT 'pending'
    CONSTRAINT plane_merge_orders_state_check CHECK (state IN
      ('pending', 'claimed', 'authorized', 'merged', 'blocked', 'head_moved', 'superseded', 'failed', 'expired')),
  runner_id             uuid,
  lease_generation      integer NOT NULL DEFAULT 0 CONSTRAINT plane_merge_orders_generation_check CHECK (lease_generation >= 0),
  lease_expires_at      timestamptz,
  attempts              integer NOT NULL DEFAULT 0 CONSTRAINT plane_merge_orders_attempts_check CHECK (attempts BETWEEN 0 AND 3),
  -- The lease generation a read credential was issued for (at most one per generation), and when the one write credential was issued.
  read_token_generation integer CONSTRAINT plane_merge_orders_read_generation_check CHECK (read_token_generation >= 1),
  write_token_issued_at timestamptz,
  -- A label for the kind of credential the minting layer issues for this order. Not a credential, and nothing in the schema depends on its value.
  token_purpose         text NOT NULL DEFAULT 'app_installation_single_use'
    CONSTRAINT plane_merge_orders_purpose_check CHECK (token_purpose ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- A fixed snake_case code (a gate reason or a merge outcome); never text from GitHub, a runner or a model.
  outcome_code          text CONSTRAINT plane_merge_orders_outcome_check CHECK (outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  deadline_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,

  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, plane_push_id) REFERENCES plane_pushes (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (runner_id),

  -- A leased order has a lease (its runner column is nulled if the runner row is deleted, and no runner then matches the fence); a waiting order has neither.
  CONSTRAINT plane_merge_orders_lease_shape CHECK (
    (state IN ('claimed', 'authorized') AND lease_generation >= 1 AND lease_expires_at IS NOT NULL)
    OR (state = 'pending' AND runner_id IS NULL AND lease_expires_at IS NULL)
    OR state NOT IN ('claimed', 'authorized', 'pending')),
  -- The write credential exists exactly once an order was authorized.
  CONSTRAINT plane_merge_orders_write_shape CHECK (state <> 'authorized' OR write_token_issued_at IS NOT NULL),
  CONSTRAINT plane_merge_orders_write_not_pending CHECK (state NOT IN ('pending', 'claimed') OR write_token_issued_at IS NULL),
  CONSTRAINT plane_merge_orders_merged_shape CHECK (state <> 'merged' OR write_token_issued_at IS NOT NULL),
  -- A finished order says when and why.
  CONSTRAINT plane_merge_orders_finished_shape CHECK (
    (state IN ('merged', 'blocked', 'head_moved', 'superseded', 'failed', 'expired')) = (finished_at IS NOT NULL)
    AND (finished_at IS NULL OR outcome_code IS NOT NULL)),
  CONSTRAINT plane_merge_orders_read_shape CHECK (read_token_generation IS NULL OR read_token_generation <= lease_generation)
);

-- One open order per work item.
CREATE UNIQUE INDEX plane_merge_orders_one_open ON plane_merge_orders (account_id, work_item_id) WHERE state IN ('pending', 'claimed', 'authorized');
-- The claim looks for the oldest waiting order of an account.
CREATE INDEX plane_merge_orders_waiting ON plane_merge_orders (account_id, created_at, id) WHERE state = 'pending';
CREATE INDEX plane_merge_orders_by_item ON plane_merge_orders (account_id, work_item_id, created_at DESC);

-- The clock, and the rules that make the table what the header says: identity never changes, the moves are the listed ones, a finished order is final,
-- the lease generation and the attempt count only grow, and the write credential's issue time is set once and never moves.
CREATE FUNCTION plane_merge_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.plane_push_id IS DISTINCT FROM OLD.plane_push_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id OR NEW.code_repo IS DISTINCT FROM OLD.code_repo
     OR NEW.pr_number IS DISTINCT FROM OLD.pr_number OR NEW.expected_public_head IS DISTINCT FROM OLD.expected_public_head
     OR NEW.reviewed_head IS DISTINCT FROM OLD.reviewed_head OR NEW.pairing_digest IS DISTINCT FROM OLD.pairing_digest
     OR NEW.token_purpose IS DISTINCT FROM OLD.token_purpose OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plane_merge_orders: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('merged', 'blocked', 'head_moved', 'superseded', 'failed', 'expired') THEN
    RAISE EXCEPTION 'plane_merge_orders: a finished order does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'pending'    AND NEW.state IN ('claimed', 'blocked', 'superseded', 'expired'))
    OR (OLD.state = 'claimed'    AND NEW.state IN ('pending', 'authorized', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('merged', 'head_moved', 'superseded', 'failed', 'expired'))) THEN
    RAISE EXCEPTION 'plane_merge_orders: % cannot become %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lease_generation < OLD.lease_generation OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'plane_merge_orders: the lease generation and the attempts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.write_token_issued_at IS NOT NULL AND NEW.write_token_issued_at IS DISTINCT FROM OLD.write_token_issued_at THEN
    RAISE EXCEPTION 'plane_merge_orders: the write credential is issued once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_token_generation IS NOT NULL AND NEW.read_token_generation IS DISTINCT FROM GREATEST(OLD.read_token_generation, COALESCE(NEW.read_token_generation, 0)) THEN
    RAISE EXCEPTION 'plane_merge_orders: the read credential generation only grows' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plane_merge_orders_guard BEFORE INSERT OR UPDATE ON plane_merge_orders
  FOR EACH ROW EXECUTE FUNCTION plane_merge_orders_guard();

ALTER TABLE plane_merge_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE plane_merge_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plane_merge_orders TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON plane_merge_orders FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON plane_merge_orders TO app_user;
REVOKE ALL ON FUNCTION plane_merge_orders_guard() FROM PUBLIC;
