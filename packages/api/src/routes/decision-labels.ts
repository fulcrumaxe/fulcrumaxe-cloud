/**
 * Customer-facing names for the Autonomy settings (D#7 DP10b). A picker or a list shows these, never an internal id (build-right rule).
 * They live here, not on the catalogue, so adding a name never changes the catalogue's pinned hash. `test/ask-settings.test.ts` fails when a
 * catalogue entry or a fixed invariant has no name, so a new one cannot reach the page as a raw id.
 */
export { DECISION_LABELS, decisionLabel } from "@fx/decisions";

export const INVARIANT_LABELS: Readonly<Record<string, string>> = {
  cross_tenant_row_access: "One account can never read another account's data",
  role_permission_grant: "What each role is allowed to do is fixed in code",
  merge_or_protection_change: "Merging, and changing branch protection, is always a person's call",
  untrusted_work_creation: "Work from an untrusted source never starts automatically",
};

export const invariantLabel = (key: string): string => INVARIANT_LABELS[key] ?? key.replace(/_/g, " ");
