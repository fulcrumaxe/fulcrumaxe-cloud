/**
 * The tables whose rows are evidence: never rewritten, and readable at
 * every stored-content version ever shipped (D#8 policy 12, R1 criterion 8,
 * R5 criterion 6). Named once, here, in the test tree: it has no production consumer. The migration
 * DML-guard test (`test/platform-audit.test.ts`) and the round-trip gate test
 * (`@fx/features` `test/roundtrip.test.ts`, which passes it to the registry
 * validator) both import this list, so they cannot drift.
 */
export const EVIDENCE_TABLES = [
  'ledger',
  'audit_log',
  'run_events',
  'agent_runs',
  'attestations',
  'decision_receipts',
  'support_access_log',
  'site_versions',
] as const;

export type EvidenceTable = (typeof EVIDENCE_TABLES)[number];
