-- The GitHub repo re-sync reconciler (D#454 H2c). The framework (0703) takes jobs that have a row; a job without one is
-- never due. Every 6 hours; the cursor is an installation id, saved when a run stops on its 30-installation budget, its call
-- budget or a rate limit.
--
-- repo_list_etags holds the per-page ETags of the last complete repository listing of an installation, so the next run can
-- ask GitHub conditionally and write nothing when every page answers 304. It is set only by the re-sync job, after a
-- complete listing was written, and the lifecycle function clears it on every deleted, suspend and unsuspend, so a
-- re-attached installation is always read in full once. platform_ops already reads installation_installers (0667); this
-- adds one column grant and defines no function.
ALTER TABLE installation_installers ADD COLUMN repo_list_etags text[];

GRANT UPDATE (repo_list_etags) ON installation_installers TO platform_ops;

INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('github_repos', 21600);
