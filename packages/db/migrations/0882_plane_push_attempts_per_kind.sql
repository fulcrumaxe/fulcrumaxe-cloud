-- D#598 P1f-5c: attempts are numbered per kind.
--
-- plane_push_attempts (0831) keyed an attempt by (plane_push_id, attempt_no) across every kind, while its push cap
-- (kind <> 'push' OR attempt_no BETWEEN 1 AND 3) counts push attempts alone. With the PR-open retry (kind 'pr_open', no sandbox and no run row) writing rows
-- of its own, one shared number space would let a PR-open retry take the number a later push attempt needs, and the cap would stop meaning "three pushes".
--
-- The key becomes (plane_push_id, kind, attempt_no): each kind counts from 1 on its own, a push row still has its three, and a PR-open retry cannot use one up.
-- The writers number the same way (the publish step and the runner's token grant take the highest push number plus one; the PR-open retry the highest
-- pr_open number plus one), under the same row lock they already hold.
--
-- Widening a unique key cannot refuse a row the old key accepted, so existing rows (all of kind 'push' until now) stay valid. The constraint keeps its
-- name. Expand-only in effect: nothing is dropped from the data, no column changes, and the only window is the swap inside this one transaction.
-- Numbered above the highest migration on the code plane and the open PRs' claims; re-checked right before merge.

ALTER TABLE plane_push_attempts DROP CONSTRAINT plane_push_attempts_no_key;
ALTER TABLE plane_push_attempts ADD CONSTRAINT plane_push_attempts_no_key UNIQUE (plane_push_id, kind, attempt_no);
