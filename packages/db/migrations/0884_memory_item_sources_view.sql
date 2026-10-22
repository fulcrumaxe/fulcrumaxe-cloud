-- D#601 MEM-8b: the read side of what a run is given besides ordinary memory entries. One view, `memory_item_sources`, and nothing else: no table, no grant on a table,
-- no function. The retriever (packages/pipeline/src/prompt/memoryRecall.ts) reads it for an item's recall; the record of what a run was given is MEM-8a's
-- `run_context_item_sources` (0880).
--
--   correction   a run note that was accepted AND applied (a later run of the item carries it forward). An accepted note that is not yet applied is the driver's, which
--                injects it once at the next run boundary; recall adds nothing to it. `proposed`, `rejected` and `superseded` notes, and every other kind (question, spec_amend,
--                new_item, pause, priority), are not rows of this view at all. `exclude_run_id` is the run that applied it: the retriever never gives a note to that run.
--   handoff      the note an agent wrote when a cloud run was handed to another side: the latest `checkpoint` event of the run (its `payload.summary`, already cleaned and capped
--                at 4 KiB by the writer) for a `run_handoffs` row whose state is `handed_off` and whose from_side is `cloud`. Any other state, and any runner side, is not a row.
--                `exclude_run_id` is the child run, which receives the note by the handoff itself.
--   receipt      an approved entry that names a decision receipt (MEM-8a's promote path). `body` is the entry's fixed label, `chosen` the receipt's text as it stands NOW (read
--                live, never copied), and `receipt_missing` says the receipt row is gone. Such an entry is skipped at recall when the receipt is missing.
--
-- `security_invoker = true`: every table is read with the QUERYING role's own privileges and row security (the same as the KPI views of 0623), so one account never sees another's rows
-- through it. app_user already holds column SELECT on everything the view reads. The view is owned by the migration role and gives platform_ops and partner_user nothing.
-- The receipt id is cast only when it has the shape of a uuid, so a malformed `provenance.receipt_id` can never make this view fail for the account.
--
-- Numbered above the highest migration on the code plane (0883). Re-check against main right before merging; migrations merge in number order.
CREATE VIEW memory_item_sources WITH (security_invoker = true) AS
  SELECT c.account_id, c.work_item_id, 'correction'::text AS source_kind, c.id AS source_id, 1 AS version, c.origin AS author_kind,
         c.body, NULL::text AS chosen, false AS receipt_missing, c.applied_at AS at, c.applied_run_id AS exclude_run_id
    FROM work_item_corrections c
   WHERE c.kind = 'run_note' AND c.status = 'applied'
  UNION ALL
  SELECT h.account_id, h.item_id, 'handoff'::text, e.id, 1, 'agent'::text,
         e.summary, NULL::text, false, h.updated_at, h.child_run_id
    FROM run_handoffs h
    JOIN LATERAL (
      SELECT ev.id, ev.payload ->> 'summary' AS summary
        FROM run_events ev
       WHERE ev.account_id = h.account_id AND ev.run_id = h.run_id AND ev.kind = 'checkpoint' AND jsonb_typeof(ev.payload -> 'summary') = 'string'
       ORDER BY ev.seq DESC
       LIMIT 1
    ) e ON true
   WHERE h.state = 'handed_off' AND h.from_side = 'cloud'
  UNION ALL
  SELECT m.account_id, NULL::uuid, 'receipt'::text, m.id, m.version, m.author_kind,
         m.body, r.chosen, (r.id IS NULL), m.approved_at, NULL::uuid
    FROM memory_entries m
    LEFT JOIN decision_receipts r
      ON r.account_id = m.account_id
     AND r.id = CASE WHEN (m.provenance ->> 'receipt_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (m.provenance ->> 'receipt_id')::uuid END
   WHERE m.status = 'approved' AND m.provenance ? 'receipt_id';

GRANT SELECT ON memory_item_sources TO app_user;
