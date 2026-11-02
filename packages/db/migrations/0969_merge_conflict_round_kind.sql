-- D#519 MQ5-b1: a round row says which kind of fix round it was.
--
-- `merge_conflict_rounds` (0948) held only conflict rounds. The ordered-resource renumber round (MQ5-b) is counted against the same bound and keeps the same
-- record, so a stored row has to stay distinguishable after the round ends. `kind` is `conflict` (every existing row, and the default) or `renumber`. It is set by
-- the INSERT that starts the round and never changes: the column is not in the UPDATE grant (0948 grants UPDATE on four columns only), and the table-level
-- INSERT grant already covers a new column.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

ALTER TABLE merge_conflict_rounds
  ADD COLUMN kind text NOT NULL DEFAULT 'conflict'
  CONSTRAINT merge_conflict_rounds_kind_check CHECK (kind IN ('conflict', 'renumber'));
