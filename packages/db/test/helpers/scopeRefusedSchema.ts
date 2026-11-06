/**
 * D#6 REFUSAL-BUILD-AGAIN-FRESH, expand step. The schema that lets a push record end in `scope_refused` is a LATER migration (the contract step); until it ships no row can hold that state.
 * Tests of code that must already handle such a row (the readers, the stamp's insert, the card) get it by applying the contract step's three schema changes by hand, for one test, and
 * undoing them after. Never use this for a test of the migration itself: the migration's own test belongs to the step that ships it.
 */
interface Admin {
  query(sql: string): Promise<unknown>;
}

const OLD_STATES = `'building', 'scanning', 'pushed', 'pr_opened', 'refused', 'pushed_pr_not_opened', 'no_public_change', 'updating', 'updated', 'waiting_person_pushed', 'managed_by_person', 'pr_closed', 'pr_merged'`;

/** Widens the state list and makes the item's unique index partial (it skips `scope_refused`). Returns the function that puts the current schema back. */
export async function withScopeRefusedSchema(admin: Admin): Promise<() => Promise<void>> {
  await admin.query(`ALTER TABLE plane_pushes DROP CONSTRAINT plane_pushes_state_check`);
  await admin.query(`ALTER TABLE plane_pushes ADD CONSTRAINT plane_pushes_state_check CHECK (state IN (${OLD_STATES}, 'scope_refused'))`);
  await admin.query(`DROP INDEX plane_pushes_item_repo_key`);
  await admin.query(`CREATE UNIQUE INDEX plane_pushes_item_repo_key ON plane_pushes (account_id, work_item_id, lower(code_repo)) WHERE state <> 'scope_refused'`);
  return async () => {
    // The refused rows go first: the full index would refuse a refused row beside its live one.
    await admin.query(`DELETE FROM plane_pushes WHERE state = 'scope_refused'`);
    await admin.query(`DROP INDEX plane_pushes_item_repo_key`);
    await admin.query(`CREATE UNIQUE INDEX plane_pushes_item_repo_key ON plane_pushes (account_id, work_item_id, lower(code_repo))`);
    await admin.query(`ALTER TABLE plane_pushes DROP CONSTRAINT plane_pushes_state_check`);
    await admin.query(`ALTER TABLE plane_pushes ADD CONSTRAINT plane_pushes_state_check CHECK (state IN (${OLD_STATES}))`);
  };
}
