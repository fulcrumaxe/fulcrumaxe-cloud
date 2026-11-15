# @fx/sitekit-checks

Deterministic, zero-model-token verification checks for a rendered
[sitekit-template](sitekit-template.md) output directory, ported from an
external `os-site-v2/tools` project into generic, multi-tenant form — none of
them make a network call, spend a model token, or write outside the directory
they check.

Sources:
- `packages/sitekit-checks/src/index.ts`
- `packages/sitekit-checks/src/types.ts`
- `packages/sitekit-checks/src/checks/links.ts`
- `packages/sitekit-checks/src/checks/meta.ts`
- `packages/sitekit-checks/src/checks/nojs.ts`
- `packages/sitekit-checks/src/checks/weight.ts`
- `packages/sitekit-checks/src/checks/redaction.ts`
- `packages/sitekit-checks/src/checks/i18nCatalogue.ts`
- `packages/sitekit-checks/src/checks/i18nChrome.ts`
- `packages/sitekit-checks/src/extra/a11y.ts`
- `packages/sitekit-checks/src/extra/a11y-structure.ts`
- `packages/sitekit-checks/src/extra/render.ts`
- `packages/sitekit-checks/src/extra/motion.ts`
- `packages/sitekit-checks/src/extra/degrade.ts`
- `packages/sitekit-checks/src/extra/headers.ts`
- `packages/sitekit-checks/src/extra/freshness.ts`
- `packages/sitekit-checks/src/extra/browser-pages.ts`
- `packages/sitekit-checks/src/lib/browser/driver.ts`
- `packages/sitekit-checks/src/lib/browser/run.ts`
- `packages/sitekit-checks/src/lib/browser/serve.ts`
- `packages/sitekit-checks/README.md`

## What it does

Each check module exports `run(renderedDir, options?): Promise<CheckResult>`
(`packages/sitekit-checks/src/types.ts`'s `CheckRun`), returning `{ ok, findings }`
where each `Finding` carries a `path`, a machine-stable `kind`, a message, and a
severity of `error` (fails the check) or `advisory` (reported, never fails it).
`packages/sitekit-checks/src/index.ts`'s `CHECKS` registry maps each check's
original tool name to its `run` function, so a caller can iterate all fourteen in
one pass.

The first seven checks, one file each under `packages/sitekit-checks/src/checks/`,
are the original set:

| Check | Source file | Purpose |
|---|---|---|
| `check-links` | `links.ts` | Every internal `href`/`src` resolves inside `renderedDir`; any external link whose host is not in `options.siteDomains` is flagged `needs_review`. Never checks link *liveness*. |
| `check-meta` | `meta.ts` | A missing `<title>`/description, or two pages sharing one, is a hard failure; title/description length is advisory only. |
| `check-nojs` | `nojs.ts` | Every page must say something (a heading, a sentence, a link) before any script runs — a minimum visible-word count with CJK-aware counting. |
| `check-weight` | `weight.ts` | Bounds the byte cost of a page's first cold visit — the HTML plus every same-origin stylesheet/script/image it references up front, excluding anything JavaScript fetches later or lazily loads. |
| `check-redaction` | `redaction.ts` | Scans rendered output for a caller-supplied deny-list of private hosts, account names and email patterns, plus a fixed set of generic secret-shaped patterns (tokens, keys, hex blobs, home paths). |
| `check-i18n-catalogue` | `i18nCatalogue.ts` | Validates `<renderedDir>/i18n/<locale>/<page>.json` translation catalogues against the English `<main>` they translate: fingerprint match, tag-skeleton match, and every dollar amount/licence id/generated-block marker preserved. |
| `check-i18n-chrome` | `i18nChrome.ts` | Every wanted nav/footer label (from `options.wantedLabels` or `<renderedDir>/i18n/chrome-labels.json`) must have a translation in every locale in `<renderedDir>/i18n/chrome.json`. |

Seven more live under `packages/sitekit-checks/src/extra/` and are in the same
`CHECKS` registry:

| Check | Source file | Purpose |
|---|---|---|
| `check-a11y` | `a11y.ts` | The accessibility rules that can be decided from markup alone (one `<h1>` per page, a skip link), with per-path exemptions. Not an audit. |
| `check-a11y-structure` | `a11y-structure.ts` | Heading order, landmarks, image alt text and controls with no accessible name, decided on the rendered page in a browser. |
| `check-render` | `render.ts` | Renders every page at each viewport width (default 390 and 1280) and optional theme, and checks what a reader sees, including text contrast. |
| `check-motion` | `motion.ts` | With reduced motion requested, flags any animation or transition that still runs. Reports at most 20 findings a page and counts the rest. |
| `check-degrade` | `degrade.ts` | With the site's runtime API calls blocked (default `/api/*`), each page's `<main>` must still hold readable text. |
| `check-headers` | `headers.ts` | Every root-level data file the site serves (`.json`, `.xml`, `.txt` by default) must match a caching rule in the caller's `headers` config. A missing config fails, since "nothing is unruled" would be a vacuous pass. |
| `check-freshness` | `freshness.ts` | Declared data sidecars must not be older than their `maxAgeDays`, and `.well-known/security.txt` must not expire within `securityTxtMinDays` (default 30). An undeclared or unparseable age is an advisory, never a silent pass. |

The browser checks (`check-a11y-structure`, `check-render`, `check-motion`,
`check-degrade`) never start a browser themselves: the caller passes one in as
`options.driver`, a `BrowserDriver` (`packages/sitekit-checks/src/lib/browser/driver.ts`,
types only, so nothing under `src/` pulls a browser into the runtime graph). They fail
closed: with no driver, a driver that will not open, a blown time budget
(`budgetMs`, default 120 seconds) or more pages than `pageCap` (default 200),
the result is `ok: false`, never a pass. A script's result is accepted only as
JSON of at most 256 KiB. The pages are served from `renderedDir` by a static
server bound to 127.0.0.1 (`packages/sitekit-checks/src/lib/browser/serve.ts`).

## Public surface

`packages/sitekit-checks/src/index.ts` exports each check individually
(`checkLinks`, `checkMeta`, `checkNojs`, `checkWeight`, `checkRedaction`,
`checkI18nCatalogue`, `checkI18nChrome`), their option types, the `CHECKS`
registry, `GENERIC_LEAK_PATTERNS`/`GENERIC_LEAK_PLANTS` (from `redaction.ts`),
`i18nFingerprint` (from `i18nCatalogue.ts`), the seven extra checks (`checkA11y`, `checkA11yStructure`, `checkRender`, `checkMotion`, `checkDegrade`, `checkHeaders`, `checkFreshness`) with their option types and the `BrowserDriver`, `BrowserPage` and `BrowserRunOptions` types, and the shared `Finding`,
`CheckResult`, `CheckOptions`, `CheckRun` types (`types.ts`).

## How it works

The originals this package ports from were wired to one fixed site (a
hardcoded directory, a specific page list, one deployment's own private
strings and nav script). This port instead: discovers pages by walking
`renderedDir` for `*.html` (`packages/sitekit-checks/src/lib/walk.ts`) rather
than a fixed page list; takes `check-redaction`'s deny-list and
`check-i18n-chrome`'s wanted-label set as `options` instead of hardcoding one
org's values.

## Data it touches

None — every check reads only files under the `renderedDir` it is pointed at.

## Security notes

`check-links`'s external-host flagging and `check-redaction`'s deny-list scan
are the two checks with direct security relevance (catching an unintended
external reference or a leaked private string in generated output); see
[security model](../security.md) for the repo-wide picture.

## Tests

Every check has at least one passing and one failing fixture under
`packages/sitekit-checks/test/fixtures/<check>/` (the browser checks run against a test driver under `packages/sitekit-checks/test/browser/`), exercised by
`packages/sitekit-checks/test/checks/*.test.ts`. Run with `pnpm test` from
`packages/sitekit-checks/` (`vitest run`); `pnpm run typecheck` runs
`tsc --noEmit`. `packages/sitekit-checks/test/parity.sh` additionally runs the
real original Python/Node tool (read from an external, unmodified directory)
against the same fixture this package's TypeScript port runs and diffs
pass/fail, recorded in `packages/sitekit-checks/test/PARITY.md`; `check-redaction`
is excluded from that parity run because the original makes a live,
unconditional network call with no offline path.

## Known gaps

`packages/sitekit-checks/package.json` ships its own package-local
`pnpm-workspace.yaml`, described as a temporary standalone-install path ahead
of a root workspace landing.
