-- Webhook catalogue clean-up: the `merge_approval.decided` event type is removed.
--
-- Nothing ever emitted it (a person merges on GitHub; there is no merge-approval record to announce), yet the catalogue let an endpoint subscribe to it.
-- The catalogue no longer contains it, so the response schema for an endpoint would refuse any stored row that still lists it. This migration takes it
-- out of every stored subscription.
--
-- An endpoint whose only subscription was this event would be left with an empty list, which the cardinality check forbids. Such an endpoint could never
-- have received a delivery, so it is parked, not deleted: it gets the harmless `endpoint.test` subscription, is disabled, and carries the reason
-- `event_removed` so the owner sees why and can pick a real event and re-enable it. An endpoint that was already disabled keeps the reason it had.
--
-- Contract-only for the catalogue, data-only here: no column, constraint or policy changes. Numbered above the highest migration on the code plane (0889);
-- re-checked right before the pull request is opened.

UPDATE webhook_endpoints
   SET event_types = array_remove(event_types, 'merge_approval.decided'),
       updated_at = now()
 WHERE 'merge_approval.decided' = ANY (event_types)
   AND cardinality(array_remove(event_types, 'merge_approval.decided')) > 0;

UPDATE webhook_endpoints
   SET event_types = ARRAY['endpoint.test'],
       disabled_reason = CASE WHEN status = 'disabled' THEN disabled_reason ELSE 'event_removed' END,
       status = 'disabled',
       updated_at = now()
 WHERE 'merge_approval.decided' = ANY (event_types);
