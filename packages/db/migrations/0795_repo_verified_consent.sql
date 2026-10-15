-- D#599 PL-2: a repository switched to runner_verified stores the SHA-256 of the cloud-verified wording the person accepted.
--
-- Why: the cloud-verified opt-in is a consent to specific words (the route takes the hash of those words back from the client, 409 copy_changed
-- when it is not the wording the server ships). Until now that proof lived and died with the request. Every run creation in this mode now
-- compares the STORED hash with the wording the server ships at that moment (packages/runner startAgentRun / resumeAgentRun, before the run's row
-- is written), so a changed wording refuses the run with a closed code until the owner or an admin consents again. A repo switched before this
-- file has no stored hash, and is treated the same way: its next run start asks for re-consent. Re-consent is the existing route (switch away
-- and back), which audits both moves.
--
-- Derived state, not a stamp that outlives its cause: the CHECK below lets the column hold a value only while the repository IS in
-- runner_verified, in the shape of a SHA-256, so leaving the mode (the route clears it in the same UPDATE) can never leave a consent behind
-- that a later switch back could ride on.
--
-- Grants: none are added or needed. app_user holds table-wide SELECT and UPDATE on repos (0001), which already covers the new column for the
-- login the run starter uses (a member of app_user). Every definer role keeps exactly the column grants it had, and platform_ops, which holds
-- column grants on repos only, gains nothing (a test diffs its privileges against the migrations without this file, and test-neon-shape.sh
-- checks that it cannot read or write the column).
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

ALTER TABLE repos ADD COLUMN verified_copy_sha256 text;

ALTER TABLE repos ADD CONSTRAINT repos_verified_copy_sha256_check
  CHECK (verified_copy_sha256 IS NULL OR (verified_copy_sha256 ~ '^[0-9a-f]{64}$' AND execution_mode = 'runner_verified'));
