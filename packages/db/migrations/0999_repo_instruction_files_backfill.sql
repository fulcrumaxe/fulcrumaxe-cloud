-- D#601 MEM-5b follow-up: a due mark for CLAUDE.md and AGENTS.md on every repository that was connected before 0998 and its triggers shipped.
--
-- A connect marks both files and a push to the default branch marks the one it changed, but a repository connected earlier has neither a row nor a push
-- to look for, so its files would wait for the next push that touches one of them. This inserts the missing rows, due a minute from now, for the
-- repositories the connect path itself covers (product = 'team' with an installation: the filter of queueDiscoveries and of markRepoFilesDue). A row
-- that already exists is left exactly as it is (its sha, its outcome and its time); a repository with only one of the two files gets the other.
--
-- Why a migration and not a guarded step in the sweep: the table is FORCE ROW LEVEL SECURITY with one tenant policy, so the only code that may write
-- across accounts is a definer function, and a definer that writes would need new grants on repos and a wider read policy for the shared lister role,
-- all for a one-time job. The migration owner is the Neon-shaped owner (BYPASSRLS, as packages/db/scripts/test-neon-shape.sh builds it) and writes the rows directly. The
-- sweep reads them at its next tick, up to ten files a tick, so a large backlog is spread over ticks and not read at once. Idempotent: a second run
-- inserts nothing. Expand-only. Numbered above the highest migration on the code plane; re-checked right before merge.

INSERT INTO repo_instruction_files (repo_id, path, account_id, due_at)
SELECT r.id, p.path, r.account_id, now() + interval '60 seconds'
  FROM repos r
 CROSS JOIN (VALUES ('CLAUDE.md'), ('AGENTS.md')) AS p (path)
 WHERE r.product = 'team' AND r.installation_id IS NOT NULL
ON CONFLICT (repo_id, path) DO NOTHING;
