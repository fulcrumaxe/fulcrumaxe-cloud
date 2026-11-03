-- D#598 P1g-3a: a person's confirmed "replace their version with the item's" is recorded as an authorization on the push record.
--
-- The authorization is the full head the person was shown when they confirmed. The fix round that follows takes its lease on exactly that head, so a push
-- made after the confirmation makes the lease fail and the person is asked again. It is single-use: the platform clears it when the update lands, when any
-- round is refused, when the branch is put back where the platform left it, and when the person chooses another answer. A sha only; nothing from a commit.
--
-- answered_request_id names the ONE request whose answer the push record currently follows: Keep (with the managed mark) or a confirmed Replace (with the
-- authorization). Keep and Replace both close a request as `marked_done`, and an item has several closed requests over its life, so the request row cannot say
-- which it was. The column is what tells a repeat of Keep from a Keep that arrives after a Replace, what stops Replace after Keep from reporting a success it
-- did not make, and what marks only the Kept request as managed on Needs you. A stamp rather than a derivation: no other column links the two rows, and
-- comparing their timestamps would rest on one transaction's clock. Cleared by the undo of Keep. A request id only.
--
-- Keep can lose to a round that already holds its lease: the lease is deliberately on the person's head, so a Keep that arrives while the round runs does not
-- stop its push (the platform cannot fence the final push of a sandbox run). Two more columns make that visible instead of silent:
-- kept_head is the head the person's Keep covered (their commit), set by Keep and cleared by its undo; kept_replaced_at says an update landed on the branch
-- after the Keep, replacing that commit, and is set by the record of the update and cleared with the undo. The branch's new head is head_sha. Shas and a time only.
--
-- Expand-only: four nullable columns on a table that already grants UPDATE to the application role. Numbered above 0978 (the highest claim among the open
-- pull requests); re-checked right before opening.

ALTER TABLE plane_pushes
  ADD COLUMN replace_authorized_head text CONSTRAINT plane_pushes_replace_authorized_check CHECK (replace_authorized_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD COLUMN answered_request_id uuid,
  ADD COLUMN kept_head text CONSTRAINT plane_pushes_kept_head_check CHECK (kept_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD COLUMN kept_replaced_at timestamptz;
