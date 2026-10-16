-- D#598 P3a: an item can say which other item its work is stacked on. work_items.stack_parent_id is nullable (NULL means the item
-- starts from the repo's main, which is every item today) and is a different link from parent_id: parent_id is provenance (who made
-- this item, read by the provenance walk), stack_parent_id is "my change builds on that item's open pull request".
--
-- Expand phase only (docs/ops/runbooks/rollback.md): one nullable column, no default, no NOT NULL, nothing dropped or rewritten. Code
-- that does not know the column keeps working, and the previous release can run against this schema.
--
-- What the database refuses at write time, for every account and every repo (no repo name, no code_repo, no account list is read):
--   * an item stacked on itself (CHECK);
--   * a parent in another account (the composite FK, as parent_id does);
--   * a parent in another repo, or either item with no repo (a stack is one repo's branches);
--   * a cycle of any length (a walk up the stack links from the new parent reaches the item itself).
-- Each refusal is a 23514 check_violation that names its constraint, so a caller tells them apart without matching text:
--   work_items_stack_cycle, work_items_stack_cross_repo.
-- Concurrent writes that would close a cycle between them are serialised by one advisory lock per account taken inside the trigger.
--
-- Undo: ON DELETE SET NULL clears the link when the parent row goes, so the child's next run starts from main. Clearing the column
-- (UPDATE ... SET stack_parent_id = NULL) is always allowed. Nothing is stamped on the child: whether a parent's PR is open, merged or
-- closed is read from that item at the time, never copied here.
--
-- app_user already holds a table-wide INSERT on work_items; the trigger below covers inserts too. Its UPDATE is column-scoped
-- (0613, 0630), so the one new column gets its own grant, exactly this column and nothing wider.
ALTER TABLE work_items ADD COLUMN stack_parent_id uuid;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_stack_parent_fk
    FOREIGN KEY (account_id, stack_parent_id) REFERENCES work_items (account_id, id) ON DELETE SET NULL (stack_parent_id),
  ADD CONSTRAINT work_items_stack_not_self CHECK (stack_parent_id IS NULL OR stack_parent_id <> id);

CREATE INDEX work_items_stack_parent_idx ON work_items (account_id, stack_parent_id) WHERE stack_parent_id IS NOT NULL;

GRANT UPDATE (stack_parent_id) ON work_items TO app_user;

-- SECURITY INVOKER on purpose: the walk below runs under the caller's own row security, so it sees the caller's tenant only, and
-- the composite FK already keeps both ends in one account.
CREATE FUNCTION work_items_stack_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_parent_repo uuid;
  v_found       boolean;
  v_cycle       boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.repo_id IS DISTINCT FROM OLD.repo_id THEN
    -- Moving an item to another repo while other items are stacked on it would leave a cross-repo stack behind.
    -- Same per-account lock as the link branch below, taken BEFORE the read: a link write and a repo move on the same account are
    -- serialised, and the statement that runs after the lock sees what the other side committed (READ COMMITTED takes a fresh
    -- snapshot per statement), so the two cannot both pass on stale data.
    PERFORM pg_advisory_xact_lock(hashtextextended('work_item_stack:' || NEW.account_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM public.work_items c
       WHERE c.account_id = NEW.account_id AND c.stack_parent_id = NEW.id AND c.repo_id IS DISTINCT FROM NEW.repo_id
    ) THEN
      RAISE EXCEPTION 'work_items: items are stacked on this item in its current repo' USING ERRCODE = 'check_violation', CONSTRAINT = 'work_items_stack_cross_repo';
    END IF;
  END IF;

  IF NEW.stack_parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stack_parent_id IS NOT DISTINCT FROM OLD.stack_parent_id AND NEW.repo_id IS NOT DISTINCT FROM OLD.repo_id THEN
    RETURN NEW;
  END IF;

  IF NEW.stack_parent_id = NEW.id THEN
    -- The CHECK would also refuse this, but a BEFORE trigger runs first; name the same constraint.
    RAISE EXCEPTION 'work_items: an item cannot be stacked on itself' USING ERRCODE = 'check_violation', CONSTRAINT = 'work_items_stack_not_self';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('work_item_stack:' || NEW.account_id::text, 0));

  SELECT p.repo_id, true INTO v_parent_repo, v_found
    FROM public.work_items p WHERE p.account_id = NEW.account_id AND p.id = NEW.stack_parent_id;
  IF NOT COALESCE(v_found, false) THEN
    -- The FK reports a missing or foreign parent; leave it that error.
    RETURN NEW;
  END IF;
  IF NEW.repo_id IS NULL OR v_parent_repo IS NULL OR NEW.repo_id <> v_parent_repo THEN
    RAISE EXCEPTION 'work_items: an item can only be stacked on an item of the same repo' USING ERRCODE = 'check_violation', CONSTRAINT = 'work_items_stack_cross_repo';
  END IF;

  WITH RECURSIVE up(id) AS (
    SELECT NEW.stack_parent_id
    UNION
    SELECT w.stack_parent_id FROM up u JOIN public.work_items w ON w.account_id = NEW.account_id AND w.id = u.id
     WHERE w.stack_parent_id IS NOT NULL
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE id = NEW.id) INTO v_cycle;
  IF v_cycle THEN
    RAISE EXCEPTION 'work_items: this stack link would create a cycle' USING ERRCODE = 'check_violation', CONSTRAINT = 'work_items_stack_cycle';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION work_items_stack_guard() FROM PUBLIC;
CREATE TRIGGER work_items_stack_guard BEFORE INSERT OR UPDATE OF stack_parent_id, repo_id ON work_items
  FOR EACH ROW EXECUTE FUNCTION work_items_stack_guard();
