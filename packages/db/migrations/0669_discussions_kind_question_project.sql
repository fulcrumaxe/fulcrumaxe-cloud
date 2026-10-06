-- D#2 H27a: discussions.kind gains 'question' (answered in its thread, never
-- built) and 'project' (a brief that becomes a plan, never built directly).
-- Only the CHECK is replaced, DROP then ADD in one transaction; every existing
-- row already satisfies the wider set. The value set must equal
-- DISCUSSION_KINDS (packages/discussions/src/discussions.ts); the db test
-- discussions-kind-question-project.test.ts fails if they drift.
--
-- work_items.kind is unconstrained text, so nothing else changes here.
-- A new file, never an edit to a merged one (D#94 R1).
ALTER TABLE discussions DROP CONSTRAINT discussions_kind_check;
ALTER TABLE discussions
  ADD CONSTRAINT discussions_kind_check CHECK (kind IN (
    'feature', 'critical', 'small', 'bug', 'doc', 'process', 'review', 'other', 'question', 'project'
  ));
