import type { Blob, Fixture } from "../../src/upcast.js";

/**
 * One fixture per shipped version of each real shape (D#8 C5c). Both are
 * v1: an untagged envelope is v1 by definition, and site_versions.content
 * is at content_schema_version 1. Key order matches what the real readers
 * emit, so a byte comparison is meaningful.
 */

/** A `site_versions.content` document, as the sitekit-claims schema stores it. */
export const SITE_CONTENT_V1: Blob = {
  site: "example",
  siteNameClaimId: "site-name",
  repo: "owner/example",
  repo_sha: "a".repeat(40),
  domains: ["example.com"],
  pages: [
    {
      slug: "home",
      sections: [
        { type: "hero", props: { titleChrome: "section.hero.title", headlineClaimId: "headline" } },
        { type: "feature-grid", props: { titleChrome: "section.features.title", featureClaimIds: ["feat-1"] } },
      ],
    },
  ],
  claims: [
    {
      id: "site-name",
      section: "hero",
      locale: "en",
      text: "Example",
      kind: "feature",
      evidence: [{ repo_sha: "a".repeat(40), path: "README.md", excerpt: "Example" }],
      verdict: "VERIFIED",
      checked_sha: "a".repeat(40),
      checked_at: "2026-09-17T00:00:00Z",
      verifier_run_id: "run-1",
    },
    {
      id: "headline",
      section: "hero",
      locale: "en",
      text: "Ship faster",
      kind: "feature",
      evidence: [],
      verdict: "ATTESTED",
      checked_sha: "a".repeat(40),
      checked_at: "2026-09-17T00:00:00Z",
      verifier_run_id: "run-1",
      attestation: { user_id: "user-1", at: "2026-09-17T00:00:00Z", version_id: "version-1" },
    },
    {
      id: "feat-1",
      section: "features",
      locale: "en",
      text: "Supports TypeScript",
      kind: "feature",
      evidence: [{ repo_sha: "a".repeat(40), path: "README.md", lines: { start: 3, end: 4 }, excerpt: "TypeScript" }],
      verdict: "VERIFIED",
      checked_sha: "a".repeat(40),
      checked_at: "2026-09-17T00:00:00Z",
      verifier_run_id: "run-1",
    },
  ],
};

/** A final agent message: prose, then the AGENT_OUTPUT block. */
export const ENVELOPE_TRANSCRIPT_V1 = [
  "Done. PR opened.",
  "",
  "<!-- AGENT_OUTPUT -->",
  "```json",
  JSON.stringify({
    agent: "executor",
    discussion: 8,
    pr: 55,
    verdict: "done",
    files_touched: ["packages/features/src/upcast.ts"],
    tokens_used: { input: 62000, output: 8400 },
  }),
  "```",
  "<!-- /AGENT_OUTPUT -->",
].join("\n");

export const realFixtures = (envelope: Blob): Fixture[] => [
  { shape: "site_content", version: 1, name: "site-versions-content-v1", blob: SITE_CONTENT_V1 },
  { shape: "agent_output_envelope", version: 1, name: "extracted-envelope-v1", blob: envelope },
];
