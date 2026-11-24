-- D#845 MC-7b: "Keep it" on an orphan. An orphan is a server with our labels that this account has no create for; the person may say they know about it and want
-- it left alone. That is a fact about the row (who, when), not a status: the row stays `orphaned` (it is still a server we did not make a row for), and the sweep and the
-- Delete route read it the same as before. Two columns, both set together or neither (a CHECK), and only while the row is an orphan or its history (`deleted`).
-- The sweep clears them when it makes a deleted row an orphan again: a server that came back is a new leftover, not the one that was kept.
-- Numbered 1074 by the Team Lead. Re-check against main's highest right before merging and renumber to stay above it.

ALTER TABLE managed_servers ADD COLUMN kept_at timestamptz;
ALTER TABLE managed_servers ADD COLUMN kept_by uuid REFERENCES users (id);
ALTER TABLE managed_servers ADD CONSTRAINT managed_servers_kept_both CHECK ((kept_at IS NULL) = (kept_by IS NULL));
ALTER TABLE managed_servers ADD CONSTRAINT managed_servers_kept_orphan CHECK (kept_at IS NULL OR status IN ('orphaned', 'deleted'));
GRANT UPDATE (kept_at, kept_by) ON managed_servers TO app_user;
