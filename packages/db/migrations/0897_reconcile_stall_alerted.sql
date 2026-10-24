-- D#6 STALL-ALERT-FAST: remember that a stuck reconcile job has already been announced.
--
-- A reconcile tick that finds a job with work waiting and a lap past twice its cadence posts one ops alert, then sets this column; it posts a
-- reminder when the value is six hours old, and a recovery notice (clearing the column) once the job passes again or has nothing to do.
-- NULL means no notice is outstanding. The row is platform-wide and already readable and updatable by platform_ops only (0703); no grant changes.
--
-- Expand-only: one nullable column, no default, nothing read by an older build. Numbered above the highest migration on the code plane (0896).
-- Re-check right before the pull request is opened and again before merging.

ALTER TABLE reconcile_jobs ADD COLUMN stall_alerted_at timestamptz;
