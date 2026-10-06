-- The Stripe reconciler's job row (D#454 H2d). The framework (0703) takes jobs that have a row; a job without one is
-- never due. Every 6 hours, like the installation and repo jobs; the cursor is an account id, saved when a run stops on
-- its 50-customer budget. The job reads accounts and calls Stripe's read-only API as platform_ops, which already holds
-- SELECT and UPDATE on accounts and reconcile_jobs, so this migration grants nothing and defines no function.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('stripe_subscriptions', 21600);
