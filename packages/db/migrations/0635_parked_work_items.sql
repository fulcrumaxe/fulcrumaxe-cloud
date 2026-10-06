-- D#2 H15b-1 (C39 ruling (b), H15b-PARK 3): the durable record of a work
-- item that triage parked.
--
-- An external-provenance work item that reaches triage in `existing` mode
-- with no discussion cannot be given one by the pipeline (createDiscussion
-- under the system principal always makes an INTERNAL root, which would
-- launder the item's provenance), and nothing before D#71 DS-7 can create
-- an external discussion. So the triage step does not retry: it ends
-- normally, leaves the work item exactly as it was, and writes ONE row
-- here. An owner/admin can list the rows later.
--
-- The row carries ids and a fixed reason code only. There is no free-text
-- column, so nothing from the untrusted title or body can reach it.
--
-- Replay safety is the database's, not a "look, then insert" check:
-- UNIQUE (account_id, work_item_id, reason) makes a replay of the same
-- intake event an `ON CONFLICT DO NOTHING` no-op.
--
-- Tenancy and grants: same tenant_isolation shape as work_item_transitions
-- (0610). app_user gets SELECT (list parked items; read back after a
-- conflicting insert) and INSERT (park). No UPDATE, no DELETE: a parked
-- record is history, and un-parking is a later task's decision. No grant
-- to partner_user or platform_ops.
--
-- Numbering: origin/main's newest migration is 0631; 0633 (H09c) and 0634
-- (API-5) are reserved, and no open PR holds 0632, so this file takes 0635
-- as assigned.
CREATE TABLE parked_work_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  reason       text NOT NULL CONSTRAINT parked_work_items_reason_check
                 CHECK (reason IN ('external_no_discussion')),
  created_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, work_item_id, reason),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);

ALTER TABLE parked_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE parked_work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parked_work_items TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON parked_work_items TO app_user;
