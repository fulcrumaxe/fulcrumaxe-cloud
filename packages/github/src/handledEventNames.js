// The GitHub webhook events the app handles. Plain ESM with no imports so bare
// `node` (for example an ops script) can import it by relative path without
// pulling in the workspace's dependencies. eventMapper.ts re-exports it.
//
// `installation` is acknowledged but produces no work_items/run mapping --
// installation provisioning is H06's, not the event mapper's.
export const HANDLED_EVENT_NAMES = Object.freeze([
  'installation',
  'installation_repositories',
  'issues',
  'issue_comment',
  'discussion',
  'discussion_comment',
  'pull_request',
  'pull_request_review',
  'push',
  // D#519 MQ3-b: CI results are only a wake-up signal for the merge queue (`onRepoEvent`); they map to no work item change.
  'check_run',
  'check_suite',
  'status',
]);
