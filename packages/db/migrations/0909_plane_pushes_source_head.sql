-- D#598 (MERGE-GATE-PLANE): record, with each public head the platform pushes, the PRIVATE head it was built from.
--
-- Why: a paired item's reviewers judge the private run branch's head; the pull request that merges is the public one, a different commit by construction.
-- `plane_pushes.head_sha` says which public head the platform pushed, but not which reviewed private head it came from. If the private branch moved to newly
-- reviewed code while a republish was pending, refused or crashed, the old public head would still match its stamp. `source_head` closes that: the merge
-- gate merges the public pull request only when its stamp's source head is the head the reviewers cleared.
--
-- What: one nullable column, written with the first push, every update (fix-round republish) and nothing else; same shape check as head_sha. Rows written
-- before this migration have NULL, and the gate reads NULL as "not known" and leaves that merge to a person.
--
-- Rollback (expand/contract): additive only. A reverted deploy ignores the column. Nothing is rewritten, dropped or made NOT NULL.
--
-- Numbered above the highest migration on the code plane (0908). Re-check against main right before merging and renumber to stay above it.

ALTER TABLE plane_pushes
  ADD COLUMN source_head text CONSTRAINT plane_pushes_source_head_check CHECK (source_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');
