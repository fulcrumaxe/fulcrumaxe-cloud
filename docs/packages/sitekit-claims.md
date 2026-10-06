# @fx/sitekit-claims

The claim schema and the render-refusal gate for site kit: every fact a generated
site shows (a feature, a price, a legal statement) has to be a `Claim` object with
evidence and a verdict, and `gateSite` decides which of those claims are actually
allowed to reach the page.

Sources:
- `packages/sitekit-claims/src/schema.ts`
- `packages/sitekit-claims/src/gate.ts`
- `packages/sitekit-claims/src/index.ts`
- `packages/sitekit-claims/test/gate.test.ts`
- `packages/sitekit-claims/test/purity.test.ts`
- `packages/sitekit-claims/package.json`

## What it does

`packages/sitekit-claims/src/schema.ts` defines the `SiteContent` document shape
(a `site` slug, a `siteNameClaimId`, `pages`, and `claims`) and the `Section`
union for the eight v1 section types (`hero`, `feature-grid`, `roadmap-list`,
`changelog`, `docs-index`, `pricing-table`, `legal-page`, `faq`). Every section's
props schema is `.strict()`, so an unrecognized field is rejected rather than
silently dropped. `packages/sitekit-claims/src/gate.ts`'s `gateSite` then
re-validates a `SiteContent` value defensively (it does not assume the caller
ran `SiteContent.parse()` first) and returns every blocker it finds in one pass,
never stopping at the first.

This package is pure — `packages/sitekit-claims/test/purity.test.ts` scans every
file under `src/` and fails if any of them imports `fs`, a network module, or a
model SDK (`@anthropic-ai/sdk`, `openai`, `undici`, ...). `gateSite` and
`assertRenderable` only ever look at the `SiteContent` object handed to them.

## Public surface

Exported from `packages/sitekit-claims/src/index.ts`:

- Schemas and types: `Claim`, `ClaimKind`, `ClaimVerdict`, `Evidence`,
  `Attestation`, `Section`, `Page`, `SiteContent`, `ChromeKeySchema`,
  `SectionType`.
- Constants: `ATTESTABLE_KINDS` (`legal`, `pricing`, `security` — the claim kinds
  that can reach render eligibility via human attestation instead of an
  automated verifier run), `ALLOWED_UI_CHROME` (the fixed dictionary keys a
  chrome-* prop may hold), `SECTION_PROPS_SCHEMA`, `CLAIM_REF_FIELDS`,
  `URL_FIELDS`.
- Functions: `isSlug`, `isAssetPath`, `parseRepoUrlShape`, `isRepoUrlHostAllowed`,
  `assertRenderable`, `gateSite`.

## How it works

`assertRenderable(claim, context)` (`packages/sitekit-claims/src/gate.ts`) is the
per-claim rule: a claim renders if its verdict is `VERIFIED`, it has at least one
evidence entry, and `checked_sha` matches the sha being rendered — or, for an
`ATTESTABLE_KINDS` claim, if its verdict is `ATTESTED` with an `attestation`
whose `version_id` matches the version being rendered.

`gateSite(content, context)` walks the whole document and reports a `Blocker`
(never throws, never stops early) for: a non-object document/page/section, a
rogue field outside the fixed key set at the document, page or section level, an
unknown section type, a props validation failure (mapped to a specific
`BlockReason` such as `missing-prop`, `free-text-prop`, or `invalid-prop-value`
by `classifyPropsIssue`), a claim id referenced but absent from `content.claims`,
a claim that resolves but fails `assertRenderable`, a duplicate claim id, an
absolute URL whose host is not in `content.domains` (or, for `github.com`, not
under `content.repo`'s own `/owner/repo` path), and a `figure` claim whose
evidence carries no `query`.

Field-level value shapes are also closed: `isSlug` bounds every slug to a
lowercase kebab-case alphabet, `isAssetPath` (`schema.ts`) only accepts a
root-relative path built entirely from that alphabet with an extension in
`png`/`jpg`/`jpeg`/`webp` — the alphabet has no `.` in it, so a traversal
segment like `..` cannot be spelled at all — and `parseRepoUrlShape` only
accepts an `https://` URL or a root-relative path/fragment, rejecting userinfo,
an explicit port, and any query string.

## Data it touches

None — this package holds no database schema and makes no query. See
[data model](../data-model.md) for where a `Claim`'s data (evidence rows,
attestations) is expected to be persisted by a consumer.

## Security notes

The `AssetPath`/`RepoUrl` shape checks close a path-traversal and host-allowlist
bypass at the schema level (`packages/sitekit-claims/src/schema.ts`); see
[security model](../security.md) for the repo-wide security picture. This
package's own defense-in-depth is entirely in `isAssetPath` and
`parseRepoUrlShape` — it does not touch a filesystem or make a request itself.

## Tests

`packages/sitekit-claims/test/gate.test.ts` table-tests `assertRenderable`
against every verdict/kind combination, and `gateSite` against: never
short-circuiting on multiple blockers, a missing referenced claim, figure-claim
evidence requiring a query, several free-text-injection bypass attempts (prose
split across object keys, nested arrays, a tag list of short strings), duplicate
claim ids, host-allowlist enforcement on `ctaHref`, rogue fields on a section, and
site/page slug validation. `packages/sitekit-claims/test/schema.test.ts` and
`packages/sitekit-claims/test/purity.test.ts` cover the schema shapes and the
no-fs/network/model-import rule respectively. Run with `pnpm test` from
`packages/sitekit-claims/` (`vitest run`); `pnpm run typecheck` runs `tsc --noEmit`.

## Known gaps

`packages/sitekit-claims/package.json` still lists its own package-local
`pnpm-workspace.yaml` and lockfile as a deliberate, temporary standalone-install
path; `packages/sitekit-claims/README.md` says these go away once a root
workspace integration lands.
