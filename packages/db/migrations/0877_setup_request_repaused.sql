-- D#598 P8b-2: the stamp that says "the check after Mark done put this request back".
--
-- A person presses Mark done on a request whose automatic check then says "not yet". The request goes back to open (0856's one allowed
-- done -> open transition) or, when the same step was asked again meanwhile, the newer open request takes the check's reason. The words
-- shown for it change ("We checked and it isn't done yet: ...") and nothing else on the row records why it is open, so this column does:
-- the time the check put it back. The sweep's own "not yet" stamps leave it alone, so a request that was never marked done keeps reading
-- "We check for this every 60 seconds".
--
-- It is a one-time stamp of an event that cannot be derived from the other columns (reopening clears the resolution on purpose). Everything
-- shown is still derived from current rows on each read (the words read it only on a request that has an automatic check). app_user may set
-- it, like the other check columns (0856's column grant); the freeze trigger lists the stamped terms and this is not one of them.
--
-- The restart key needs no column: one generation of a request's life ends with one resolution, and the table already stamps `resolved_at`
-- on each one, so the key is built from (request id, resolved_at) in packages/core/src/setup-requests/store.ts.
--
-- Expand-only: one nullable column and its grant; nothing existing is dropped, renamed or narrowed. Numbered above the highest migration on
-- the code plane and the open PRs' claims; re-checked right before opening.

ALTER TABLE setup_requests ADD COLUMN repaused_at timestamptz;

GRANT UPDATE (repaused_at) ON setup_requests TO app_user;
