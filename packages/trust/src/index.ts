/**
 * Before wiring this package into a pipeline step (H13/H14/H15/H22), read
 * `packages/trust/README.md`'s "Pipeline requirements" — seven rules a
 * caller of these exports must follow (sanitize per comment, never a
 * concatenation; re-resolve permission/allowlist per event; sanitize
 * titles/labels/branch names/commit messages/CI output too; normalize
 * provenance at write time; never try/catch autoMergeAllowed into `true`;
 * H22 owns the prompt budget; display rawBody, prompt from storedBody).
 * This module's own behavior satisfies its half of each rule; the other
 * half is the caller's to keep.
 */
export * from "./sanitize.js";
export * from "./author-trust.js";
export * from "./work-gate.js";
export * from "./provenance.js";
