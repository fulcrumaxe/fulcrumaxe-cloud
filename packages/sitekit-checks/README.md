# @fx/sitekit-checks

Deterministic, zero-model-token verify checks for a rendered site-kit site,
ported from `os-site-v2/tools/`: `check-links`, `check-meta`, `check-nojs`,
`check-weight`, `check-redaction`, `check-i18n-catalogue`, `check-i18n-chrome`,
and (in `src/extra/`) `check-a11y`, `check-headers`, `check-freshness`.

Options for the `extra` checks (paths use a leading `/`):

- `check-a11y`: `h1ExemptPaths` (default `[]`), `skipLinkExemptPaths` (default
  `["/404.html"]`), `skipLinkClass` (default `"skip-link"`).
- `check-headers`: `headers` is **required** (Vercel's `headers` shape, the config
  the publish step deploys with); without it the check fails with
  `headers_config_missing`. Also `servedExtensions`, `noCache`, `notServed`.
- `check-freshness`: `sidecars` (`{ path, timestampKey?, maxAgeDays }[]`, default
  none), `now` (injected clock), `securityTxtMinDays` (default 30). A sidecar with
  no declared timestamp is an advisory, not a pass.

The browser checks (render, a11y-structure, degrade, motion, search) are K12b.

Each check exposes:

```ts
run(renderedDir: string, options?: CheckOptions): Promise<{ ok: boolean; findings: Finding[] }>
```

Import them individually or via the `CHECKS` registry:

```ts
import { CHECKS } from "@fx/sitekit-checks";

const { ok, findings } = await CHECKS["check-links"](renderedDir, {
  siteDomains: ["example.com"],
});
```

None of these checks make a network call, spend a model token, or write
outside `renderedDir`. Link *liveness* (whether an external URL actually
resolves) is explicitly out of scope here — see `src/checks/links.ts`.

## Why the checks are generic, not os-site-v2-specific

The originals are wired to one fixed site: a hardcoded `formal-support/`
directory, a specific page list module (`sitepages.py`), and — in
`check-redaction.mjs` and `check-i18n-chrome.py` — that one deployment's own
private strings and nav script. A site kit renders a different customer's
site on every run, so this port:

- discovers pages by walking `renderedDir` for `*.html`, rather than a fixed
  page-directory list;
- takes `check-redaction`'s deny-list (private hosts, account names, email
  patterns) as `options`, instead of hardcoding one org's strings; and
- takes `check-i18n-chrome`'s wanted-label set as `options.wantedLabels`,
  instead of regex-parsing one hardcoded `sync-nav.mjs`.

See each check's module docstring for the specific behavioral notes, and
`test/PARITY.md` for a real run of the original tool against the same
fixture as the port, for every check where that is possible.

## Testing

```bash
pnpm install
pnpm test          # vitest — zero model tokens, no network, no live GITHUB_TOKEN
```

Every check has at least one passing and one failing fixture under
`test/fixtures/<check>/`.

## Browser checks: the driver seam

A browser check takes `options.driver: BrowserDriver` (`open()` and `close()`;
the `BrowserPage` methods are in `src/lib/browser/driver.ts`). `src/` imports no
browser. Scripts passed to `evaluate` are constants; data goes in `arg`. A
missing driver, one that will not open, a blown budget (`budgetMs`, default
120 s), more than `pageCap` (200) pages or a non-JSON / over-256 KiB result is
`ok: false` (`browser_driver_missing`, `browser_unavailable`, `check_timeout`,
`page_cap_exceeded`, `browser_result_invalid`), never a pass.
`notApplicable(reason)` is the only way a browser check skips.

Browser checks listen on `127.0.0.1` only (`serveStatic`) and make no outbound
call: the adapter aborts every request that leaves the served origin and runs
Chromium with `--disable-shared-workers`, because a SharedWorker's requests
bypass request interception (a production adapter must do the same). Two test
tiers: `pnpm test` uses a fake driver and no browser; `pnpm --filter
@fx/sitekit-checks test:browser` drives real Chromium through `playwright-core`
(a devDependency) and needs `PLAYWRIGHT_BROWSERS_PATH` (`nix develop` sets it).
`scripts/check.sh` runs it when that variable is set.

`check-render` and `check-a11y-structure` open every rendered page in a browser
through `options.driver` (required; without it they return
`browser_driver_missing`). `check-render` takes `viewports` (default
`[390, 1280]`; under 500 px is a phone), `themes` (`{ attr, values }[]`, one
pass per value, default none) and `skipPaths` (default `["/404.html"]`);
`check-a11y-structure` takes `skipPaths` (default none). Each finding carries
`path`, `viewport` and `selector` where they apply, and a one-line `hint`.
A page the server answers with 400 or more, or that will not load, is
`page_load_failed`; an adapter must throw from `goto` in that case.

`check-motion` emulates `prefers-reduced-motion: reduce` and reports each element that
still animates or transitions over 0.01 s (`motion_not_reduced`, at most 20 per page; the
rest are counted in `summary.not_reported`). `check-degrade` blocks `blockPaths` (default
`["/api/*"]`), waits `settleMs` (default 3000), and fails a page whose `<main>` has 15
characters or fewer, or only "Loading"/"Reading" wording (`degrade_no_useful_text`), or is
missing (`degrade_no_main`). Both take `skipPaths` (default none).

## Parity

```bash
bash test/parity.sh
```

Runs the *actual* original os-site-v2 Python/Node tool (read from
`ORIGINAL_TOOLS_DIR` (required; set it to your os-site-v2/tools checkout), never
modified — copied into a scratch harness so its own
`SITE = HERE/../formal-support` resolves to the fixture instead of the real
site) against the same fixture this package's TypeScript port runs, and
diffs pass/fail. `check-redaction` is the one check this script cannot run:
the original makes a live, unconditional GitHub GraphQL call with no offline
path. See `test/PARITY.md` for the last real run's output, committed as
required by D#2606 K02.

## Packaging note — the package-local `pnpm-workspace.yaml`

This package ships its own `pnpm-workspace.yaml` (with
`allowBuilds: { esbuild: true }`) so `pnpm install` works standalone, ahead
of D#2605 H01's root workspace landing. Once H01 merges, integration step I1
removes `packages/sitekit-checks/pnpm-workspace.yaml` — a root workspace
covers build approval for every package, and a package-local one would then
just be a second, redundant place that setting could drift.
