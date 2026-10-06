import { SKIP_LINK_EN } from "./chrome.js";
import { escapeHtml } from "./html.js";

export interface DocumentInput {
  title: string;
  description: string;
  bodyHtml: string;
}

/**
 * Wraps one page's body in a full static HTML document. No <script> tag is
 * ever emitted by this package — content must not require client JS
 * (D#2606 K03 pass/fail item 1), so there is nothing to hydrate.
 */
export function htmlDocument({ title, description, bodyHtml }: DocumentInput): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<a class="skip-link" href="#main">${escapeHtml(SKIP_LINK_EN)}</a>
${bodyHtml}
</body>
</html>
`;
}
