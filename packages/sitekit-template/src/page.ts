import { CLAIM_REF_FIELDS, type Page, type SiteContent } from "@fx/sitekit-claims";
import { renderSection } from "./sections.js";
import { resolveClaim, siteDisplayName, siteDisplayNameHtml } from "./claims.js";
import { chrome } from "./chrome.js";
import { escapeHtml } from "./html.js";
import { htmlDocument } from "./layout.js";
import type { RenderEnv } from "./assets.js";

/**
 * D#2606 K03 URL convention: clean, extension-less directory routing — the
 * page whose slug is "home" is served at "/" (dist "index.html"); every
 * other page is served at "/<slug>" (dist "<slug>/index.html"). This is
 * not a free choice: K01's `RepoUrl` (what `ctaHref` is typed as) can only
 * ever hold slug-shaped path segments — its alphabet has no dot in it, so
 * an href like "/docs.html" is rejected as "not-url-like" before it ever
 * reaches this package. K02's `check-links` already expects exactly this
 * directory-with-index-html convention: a target like "/docs" that isn't a
 * file resolves by checking for "docs/index.html" (see
 * `sitekit-checks/src/checks/links.ts`'s `resolves()`).
 */
export function pageOutputPath(page: Page): string {
  return page.slug === "home" ? "index.html" : `${page.slug}/index.html`;
}

function pageHref(page: Page): string {
  return page.slug === "home" ? "/" : `/${page.slug}`;
}

/** A page's own nav/tab label. Every section type's `titleChrome` is
 * boilerplate chrome text (never product-specific prose), so it is safe to
 * reuse as this page's label without inventing a separate free-text field. */
function pageLabel(page: Page): string {
  const first = page.sections[0];
  return first ? chrome(first.props.titleChrome) : page.slug;
}

function renderNav(content: SiteContent): string {
  const links = content.pages
    .map((p) => `<a href="${escapeHtml(pageHref(p))}">${escapeHtml(pageLabel(p))}</a>`)
    .join("\n");
  return `<header class="site-header">
<a class="site-name" href="/">${siteDisplayNameHtml(content)}</a>
<nav>${links}</nav>
</header>`;
}

function renderFooter(): string {
  return `<footer class="site-footer"><p>${escapeHtml(chrome("footer.credit"))}</p></footer>`;
}

/** Every claim id referenced anywhere on a page, via K01's own field map —
 * reused rather than re-guessing per-type shapes (mirrors gate.ts). */
function claimIdsOnPage(page: Page): string[] {
  const ids: string[] = [];
  for (const section of page.sections) {
    const fields = CLAIM_REF_FIELDS[section.type] ?? [];
    for (const field of fields) {
      const value = (section.props as Record<string, unknown>)[field];
      if (typeof value === "string") {
        ids.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") ids.push(item);
        }
      }
    }
  }
  return ids;
}

/** A meta description built from the page's own claim text, so it is both
 * truthful (it's the same words the page renders) and naturally distinct
 * per page — K02's check-meta fails a build on two pages sharing one. */
function pageDescription(content: SiteContent, page: Page): string {
  const ids = claimIdsOnPage(page);
  const texts = ids.slice(0, 3).map((id) => resolveClaim(content, id).text);
  const desc = texts.join(" ").trim();
  if (desc.length >= 40) {
    return desc.slice(0, 200);
  }
  return `${siteDisplayName(content)} — ${pageLabel(page)}. ${desc}`.trim();
}

export interface RenderedPageHtml {
  html: string;
}

/**
 * Renders one page's full HTML document. Assumes `content` has already
 * passed `gateSite` with zero blockers (render.ts's job) — this function
 * only formats already-cleared content.
 */
export function renderPage(content: SiteContent, page: Page, env: RenderEnv): RenderedPageHtml {
  // A page with no sections still needs its one <h1>: fall back to the label.
  const sectionsHtml = page.sections.length
    ? page.sections.map((section, i) => renderSection(content, section, env, i === 0)).join("\n")
    : `<h1 class="section-heading">${escapeHtml(pageLabel(page))}</h1>`;
  const bodyHtml = `${renderNav(content)}\n<main id="main">\n${sectionsHtml}\n</main>\n${renderFooter()}`;
  const title = `${siteDisplayName(content)} — ${pageLabel(page)}`;
  const description = pageDescription(content, page);
  return { html: htmlDocument({ title, description, bodyHtml }) };
}
