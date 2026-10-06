# @fx/sitekit-template

The fixed, English, v1 site template for site kit: it takes a `SiteContent`
document (from [sitekit-claims](sitekit-claims.md)) and renders it to static
HTML — one file per page, no client-side JavaScript framework, every rendered
claim carrying a `data-claim-id` and a visible evidence link back to the repo.

Sources:
- `packages/sitekit-template/src/render.ts`
- `packages/sitekit-template/src/page.ts`
- `packages/sitekit-template/src/sections.ts`
- `packages/sitekit-template/src/chrome.ts`
- `packages/sitekit-template/src/claims.ts`
- `packages/sitekit-template/src/assets.ts`
- `packages/sitekit-template/src/html.ts`
- `packages/sitekit-template/src/index.ts`
- `packages/sitekit-template/package.json`
- `packages/sitekit-template/README.md`

## What it does

`renderSite(content, context, assetRoot)` (`packages/sitekit-template/src/render.ts`)
calls `gateSite` first and throws `RenderBlockedError` — generating no HTML at
all — if there is any blocker. Only then does it render each page's sections
(`packages/sitekit-template/src/sections.ts`) to an HTML string and hand the
result to `writeRenderedSite`, which writes one file per page, copies every
referenced asset from a sandboxed asset root, and writes a shared stylesheet
built from [`@fx/design`](design.md)'s token set.

`packages/sitekit-template/package.json`'s `description` calls this package a
"Next.js-facing" template. At this HEAD, that description does not match what
the code does: `page.ts` produces plain HTML strings, and `render.ts`
(`writeRenderedSite`) writes them straight to disk with `node:fs` — there is
no `next`, `react`, or `react-dom` dependency anywhere in
`packages/sitekit-template/package.json`, and nothing under
`packages/sitekit-template/src/` imports either. `packages/sitekit-template/README.md`
itself says this package is "a pure, dependency-light static-HTML generator,
not a Next.js application," and that "Next.js site template" is meant to
describe a future consumer that has not been built yet, not a requirement on
this package's own tooling. The code confirms the README's clarification, not
the `package.json` wording.

## Public surface

Exported from `packages/sitekit-template/src/index.ts`:

- `renderSite`, `writeRenderedSite`, `RenderBlockedError`, `SITE_CSS`
  (`render.ts`).
- `renderPage`, `pageOutputPath` (`page.ts`); `renderSection` (`sections.ts`).
- `CHROME_EN`, `chrome` (`chrome.ts`) — the fixed English copy dictionary.
- `resolveClaim`, `claimText`, `evidenceUrl`, `renderClaimText`,
  `siteDisplayName`, `siteDisplayNameHtml`, `MissingClaimError` (`claims.ts`).
- `resolveAssetPath`, `referenceAsset`, `AssetResolutionError` (`assets.ts`).
- `htmlDocument` (`layout.ts`); `escapeHtml` (`html.ts`).

## How it works

Every visible string a section renderer emits is one of three things: escaped
claim text via `renderClaimText` (always paired with `data-claim-id` and an
evidence link), a fixed chrome string from `packages/sitekit-template/src/chrome.ts`'s
`CHROME_EN` (the only file in this package allowed to contain bare English
prose — `packages/sitekit-template/test/branding.test.ts` locks it down as a
source-text check), or a technical value (`ctaHref`, `backgroundImage`) used
only as an attribute, never as visible text.

`packages/sitekit-template/src/assets.ts`'s `resolveAssetPath` re-validates the
`AssetPath` shape from `@fx/sitekit-claims`, resolves it against a fixed asset
root with `path.resolve`, and rejects the result unless it still starts with
that root before ever calling `fs.statSync` on it — defense in depth on top of,
not instead of, the schema's own traversal-proof alphabet.

Images are referenced only through `<img src>`; SVG is not inlined, and
`AssetPath`'s extension allowlist (`png`/`jpg`/`jpeg`/`webp`) already excludes
`.svg`.

## Data it touches

None directly. See [data model](../data-model.md) for how a `SiteContent`
document's claims are expected to be persisted upstream of this package.

## Security notes

Asset path resolution is sandboxed (see How it works). See
[security model](../security.md) for the repo-wide picture.

## Tests

`packages/sitekit-template/test/gate.fixture.test.ts` renders
`test/fixtures/site.blocked.json` (a fixture with a false claim, an
evidence-less claim, and an unattested legal claim) and asserts the render is
refused, naming every blocking claim id. `packages/sitekit-template/test/render.test.ts`
covers the happy-path fixture (`test/fixtures/site.json`).
`packages/sitekit-template/test/checks.integration.test.ts` runs
[sitekit-checks](sitekit-checks.md)'s mechanical checks against the rendered
fixture output. `packages/sitekit-template/test/branding.test.ts` locks the
`CHROME_EN` credit line's source text. Run with `pnpm test` from
`packages/sitekit-template/` (`vitest run`); `pnpm run test:gate` runs only the
gate-refusal fixture test; `pnpm run build:fixture` renders
`test/fixtures/site.json` to `dist-fixture/`; `pnpm run typecheck` runs
`tsc --noEmit`.

## Known gaps

`packages/sitekit-template/package.json`'s `description` calls this a
"Next.js-facing" template — see What it does above for why that phrase does not
describe the code at this HEAD.
