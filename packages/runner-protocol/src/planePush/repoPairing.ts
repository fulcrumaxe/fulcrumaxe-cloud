/**
 * A repo's pairing with a public code repo, as the push route reads it. The one definition: the cloud's core pairing module re-exports this type
 * (it keeps the storage and validation), and the push route in this directory takes it as input.
 */
export interface RepoPairing {
  enabled: boolean;
  /** `owner/name` of the paired public repo, or null when off. */
  codeRepo: string | null;
  /** The paths that stay private; empty when off. */
  overlayGlobs: string[];
  /** A rule file committed in the private repo, or null (only the always-on refusals then run). */
  identifierRulesPath: string | null;
  planDataRulesPath: string | null;
}
