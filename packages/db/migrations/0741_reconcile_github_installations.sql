-- The GitHub installation-state reconciler's job row (D#454 H2b). The framework (0703) takes jobs that have a row; a job
-- without one is never due. Every 6 hours; the cursor is "<kind index>:<last installation id finished>", saved when a run
-- stops on its call budget or a rate limit. The job reads installations and installation_installers as platform_ops
-- (both already granted, 0613/0650/0667) and changes installation state only through the webhook path's own lifecycle
-- function, so this migration grants nothing and defines no function.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('github_installations', 21600);
