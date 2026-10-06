import { renderStylesheet } from "../../src/index.js";
import { TOKEN_SETS } from "../../src/css/tokens.js";
import * as html from "../../src/html/index.js";

/**
 * The fixture's stylesheet — the same `renderTokens(terminal) + base.css`
 * chain every consumer uses. Not embedded in fixture/page.html (that would
 * duplicate base.css's ~285 lines into a checked-in file on every change
 * for no test-relevant reason: K02's check-nojs/check-meta/check-weight
 * never look at CSS). `scripts/build-fixture.ts` writes it next to
 * page.html as fixture/site.css for real browser viewing; that file is
 * gitignored and regenerated on demand, not checked in.
 */
export function buildFixtureStylesheet(): string {
  return renderStylesheet(TOKEN_SETS.terminal);
}

/**
 * Builds fixture/page.html's exact content from the real H24 renderers.
 * Shared by scripts/build-fixture.ts (which writes the checked-in file)
 * and test/fixture-checks.test.ts (which re-runs this and asserts the
 * checked-in file still matches it — no drift between the two).
 */
export function buildFixturePage(): string {
  const headerHtml = html.header({
    siteName: "Fixture Site",
    links: [
      { label: "Features", href: "/#features", current: true },
      { label: "Pricing", href: "/pricing" },
      { label: "Docs", href: "/docs" },
    ],
  });

  const intro = `<p>This fixture page exists to prove the H24 shared design layer renders a
  real page end to end: a header, a card, a primary button, a code block, and
  the three page states a dashboard needs — loading, empty and error — all
  styled from one token set with no page-specific colour or spacing.</p>`;

  const cardHtml = html.card({
    label: "Design layer",
    title: "One source of style",
    body: "Every colour and spacing value below comes from a token set, never a literal.",
    href: "/design",
  });

  const buttonHtml = html.button({ label: "Get started", href: "/start", variant: "primary" });

  const codeHtml = html.codeBlock({ label: "install", code: "pnpm add @fx/design" });

  const statesHtml = [
    html.stateMessage({ variant: "loading", message: "Loading the latest release…" }),
    html.stateMessage({ variant: "empty", message: "Nothing here yet." }),
    html.stateMessage({ variant: "error", message: "Could not load that page." }),
  ].join("\n");

  const footerHtml = html.footer({
    creditText: "Built with the fulcrumaxe shared design layer.",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Pricing", href: "/pricing" },
    ],
  });

  const bodyHtml = `${headerHtml}
<main>
<section>
<h2 class="section-heading">Overview</h2>
${intro}
<div class="card-grid">
${cardHtml}
</div>
${buttonHtml}
${codeHtml}
${statesHtml}
</section>
</main>
${footerHtml}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>H24 design layer fixture</title>
<meta name="description" content="A static fixture page rendered entirely through the H24 shared design layer's src/html renderers and one token set, used to prove K02's mechanical checks pass.">
<link rel="stylesheet" href="site.css">
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
