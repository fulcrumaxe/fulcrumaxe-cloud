-- D#103: work_items.provenance vocabulary fix. Three panel seats (D#70
-- technical-architect, D#71 technical-architect, D#71 security-expert)
-- independently flagged that 0001_core.sql's CHECK allows
-- ('trusted','external') while packages/trust/src/work-gate.ts's
-- autoMergeAllowed accepts only the exact literal 'internal' -- every row
-- read from Postgres was therefore treated as external, failing closed
-- but silently.
--
-- The DB changes to match the code, not the other way around: 'internal'/
-- 'external' is already work-gate.ts's exported Provenance type, the
-- README rule 4 literals, and the engine's own labels. This migration
-- drops the old CHECK, rewrites any pre-existing 'trusted' row to
-- 'internal', then adds the new CHECK. autoMergeAllowed itself
-- (packages/trust/src/work-gate.ts) is unchanged.
--
-- Numbering: main's newest migration is 0606_derived_account_status.sql
-- (PR #93, merged) when this file was written, which would make 0607 the
-- next free number under D#94 rule R1. This file takes 0608 instead:
-- D#37 correction C15 also assigns 0607, to
-- packages/db/migrations/0607_revoked_sessions.sql, in PR #114's upcoming
-- fix round. That number had not yet been pushed to PR #114's branch at
-- the time this file was written, but taking 0608 here avoids the
-- collision entirely rather than racing to claim 0607 first. Renumber
-- above main's newest again at rebase if main has moved.
--
-- Constraint name: 0001_core.sql's inline `CHECK (provenance IN
-- ('trusted', 'external'))` on the CREATE TABLE is auto-named
-- `work_items_provenance_check` (Postgres's `<table>_<column>_check`
-- convention for an unnamed CHECK) -- confirmed against the ephemeral
-- test cluster this migration runs in (packages/db test suite). No IF
-- EXISTS: a silent skip would leave the old CHECK in place instead of
-- surfacing a wrong name.
ALTER TABLE work_items
  DROP CONSTRAINT work_items_provenance_check;

UPDATE work_items SET provenance = 'internal' WHERE provenance = 'trusted';

ALTER TABLE work_items
  ADD CONSTRAINT work_items_provenance_check CHECK (provenance IN ('internal', 'external'));
