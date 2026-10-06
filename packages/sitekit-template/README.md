# @fx/sitekit-template

The fixed, English, v1 site template for site kit (D#2606 K03). Renders a
`SiteContent` document (from `@fx/sitekit-claims`) to static HTML — one file
per page, no client JavaScript required for content, every rendered claim
carrying `data-claim-id` and a visible evidence link back to the repo.

## What this is (and isn't)

This package is a pure, dependency-light static-HTML generator, not a
Next.js application. K03's own pass/fail criteria only require producing
static HTML that K02's mechanical checks pass — nothing here needs `next
build`, `next dev`, or an app-router tree. The eventual customer-facing
product (a later milestone: K08's publish adapter) is expected to scaffold
a real Next.js app per customer and either import these render functions
directly from a route handler / build step, or reuse the section-rendering
logic behind React components — this package is what that scaffold renders
*from*. Treat "Next.js site template" as describing that eventual consumer,
not a requirement that this package itself run Next.js tooling.

## Render pipeline

1. `renderSite(content, context, assetRoot)` calls `gateSite` **first**. If
   there is any blocker, it throws `RenderBlockedError` (carrying every
   blocker and the de-duplicated claim ids) without generating a single byte
   of HTML — never render-then-check.
2. Each page's sections are dispatched to a renderer in `src/sections.ts`.
   Every string a renderer can emit is one of: escaped claim text (via
   `renderClaimText`, always paired with `data-claim-id` and an evidence
   link), a fixed UI-chrome string (`src/chrome.ts`, the *only* file allowed
   to contain bare English prose), or a technical value (`ctaHref`,
   `backgroundImage`) used only in an attribute, never as visible text.
3. `writeRenderedSite` writes each page's HTML, copies every referenced
   asset from the sandboxed asset root, and writes the shared stylesheet.

## Decisions this task made (D#2606 K03 constraints)

- **SVG is not inlined.** Images are referenced only via `<img src>`. K01's
  `AssetPath` already excludes `.svg` "until K03 settles whether it inlines
  SVG markup" — this package settles it: no inlining, so no change to K01's
  extension allowlist is needed, and there is no SVG-sanitization pipeline
  here. Inlining raw SVG markup would mean executing untrusted-shaped
  content in the page (`<script>`/event-handler attributes are valid inside
  `<svg>`), and nothing in K03's pass/fail list needs it — `<img src>` is
  strictly safer and simpler for a v1 template.
- **Asset resolution is sandboxed, not a plain path join.** `src/assets.ts`
  re-validates the `AssetPath` shape, resolves it against a fixed asset
  root, and confirms the resolved real path is still inside that root
  before ever calling `fs.stat` on it — defense in depth on top of, not
  instead of, K01's own traversal-proof `AssetPath` schema.
- **Chrome keys are template-owned.** `src/chrome.ts`'s `CHROME_EN` is the
  only file in this package allowed to contain a literal English sentence.
  A source-text test (`test/branding.test.ts`) locks the credit line down
  the same way `test/purity.test.ts` locks K01's package down.
- **The displayed site name always comes from `siteNameClaimId`**, resolved
  and rendered like any other claim (`data-claim-id` + evidence link) —
  never from `SiteContent.site`, which is an internal slug.
- **`ctaHref` and `RepoUrl`-typed props render only as link targets.** The
  visible label always comes from a chrome key or a claim; the URL string
  itself never appears as text content.

## Scripts

- `pnpm run build:fixture` — renders `test/fixtures/site.json` to
  `dist-fixture/` (D#2606 K03 pass/fail item 1).
- `pnpm run test:gate` — runs `test/gate.fixture.test.ts`, which renders
  `test/fixtures/site.blocked.json` (one FALSE claim, one evidence-less
  claim, one unattested legal claim) and asserts the render is refused,
  naming all three claim ids (umbrella check 2). `site.blocked.json` is a
  separate fixture from `site.json` — see that test file's docstring for
  why: `site.json` also has to render *successfully* for pass/fail items
  1/2/4/5, which a fixture containing unrenderable claims cannot do.
- `pnpm test` — the rest of the suite (rendering, K02 checks integration,
  branding).
- `pnpm run typecheck` — `tsc --noEmit`.

This package carries its own `pnpm-workspace.yaml` (`allowBuilds: {esbuild:
true}`), matching `@fx/sitekit-claims` and `@fx/sitekit-checks`, so it stays
consistent with its siblings if ever installed standalone. It does not carry
its own lockfile — nothing here needs a standalone install path, and the
root workspace's `pnpm install` already covers development and CI.
