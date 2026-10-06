import type { Section, SiteContent } from "@fx/sitekit-claims";
import { chrome } from "./chrome.js";
import { renderClaimText } from "./claims.js";
import { escapeHtml } from "./html.js";
import { referenceAsset, type RenderEnv } from "./assets.js";

export type HeadingTag = "h1" | "h2";

function heading(titleChrome: Parameters<typeof chrome>[0], tag: HeadingTag): string {
  return `<${tag} class="section-heading">${escapeHtml(chrome(titleChrome))}</${tag}>`;
}

function claimList(content: SiteContent, ids: readonly string[], listTag: "ul" | "ol" = "ul"): string {
  const items = ids.map((id) => `<li>${renderClaimText(content, id)}</li>`).join("\n");
  return `<${listTag}>\n${items}\n</${listTag}>`;
}

function renderHero(
  content: SiteContent,
  props: Extract<Section, { type: "hero" }>["props"],
  env: RenderEnv,
  tag: HeadingTag,
): string {
  const parts: string[] = [`<section class="hero">`, heading(props.titleChrome, tag)];

  if (props.headlineClaimId) {
    parts.push(`<p class="hero-headline">${renderClaimText(content, props.headlineClaimId)}</p>`);
  }
  if (props.subheadlineClaimId) {
    parts.push(`<p class="hero-sub">${renderClaimText(content, props.subheadlineClaimId)}</p>`);
  } else if (props.subtitleChrome) {
    parts.push(`<p class="hero-sub">${escapeHtml(chrome(props.subtitleChrome))}</p>`);
  }
  if (props.statusClaimId) {
    parts.push(`<p class="hero-status">${renderClaimText(content, props.statusClaimId)}</p>`);
  }
  if (props.backgroundImage) {
    // Decision (D#2606 K03): backgroundImage is referenced only via
    // <img src>, never inlined as markup — see README "SVG decision".
    const src = referenceAsset(env, props.backgroundImage);
    parts.push(`<img class="hero-bg" src="${escapeHtml(src)}" alt="" role="presentation">`);
  }
  if (props.ctaHref && props.ctaChrome) {
    // ctaHref renders ONLY as a link target — the visible label always
    // comes from chrome copy, never from the URL string itself.
    parts.push(`<a class="cta" href="${escapeHtml(props.ctaHref)}">${escapeHtml(chrome(props.ctaChrome))}</a>`);
  }

  parts.push(`</section>`);
  return parts.join("\n");
}

function renderFeatureGrid(content: SiteContent, props: Extract<Section, { type: "feature-grid" }>["props"], tag: HeadingTag): string {
  return `<section class="feature-grid">
${heading(props.titleChrome, tag)}
${claimList(content, props.featureClaimIds)}
</section>`;
}

function renderRoadmapList(content: SiteContent, props: Extract<Section, { type: "roadmap-list" }>["props"], tag: HeadingTag): string {
  return `<section class="roadmap-list">
${heading(props.titleChrome, tag)}
${claimList(content, props.itemClaimIds, "ol")}
</section>`;
}

function renderChangelog(content: SiteContent, props: Extract<Section, { type: "changelog" }>["props"], tag: HeadingTag): string {
  return `<section class="changelog">
${heading(props.titleChrome, tag)}
${claimList(content, props.entryClaimIds, "ol")}
</section>`;
}

function renderDocsIndex(content: SiteContent, props: Extract<Section, { type: "docs-index" }>["props"], tag: HeadingTag): string {
  const id = props.anchor ? ` id="${escapeHtml(props.anchor)}"` : "";
  return `<section class="docs-index"${id}>
${heading(props.titleChrome, tag)}
${claimList(content, props.docClaimIds)}
</section>`;
}

function renderPricingTable(content: SiteContent, props: Extract<Section, { type: "pricing-table" }>["props"], tag: HeadingTag): string {
  const lead = props.leadClaimId ? `<p class="pricing-lead">${renderClaimText(content, props.leadClaimId)}</p>` : "";
  return `<section class="pricing-table">
${heading(props.titleChrome, tag)}
${lead}
${claimList(content, props.planClaimIds, "ul").replace("<ul>", '<ul class="pricing-plans">')}
</section>`;
}

function renderLegalPage(content: SiteContent, props: Extract<Section, { type: "legal-page" }>["props"], tag: HeadingTag): string {
  const id = props.anchor ? ` id="${escapeHtml(props.anchor)}"` : "";
  const paragraphs = props.bodyClaimIds.map((id_) => `<p>${renderClaimText(content, id_)}</p>`).join("\n");
  return `<section class="legal-page"${id}>
${heading(props.titleChrome, tag)}
${paragraphs}
</section>`;
}

function renderFaq(content: SiteContent, props: Extract<Section, { type: "faq" }>["props"], tag: HeadingTag): string {
  const items = props.qnaClaimIds.map((id) => `<div class="faq-item">${renderClaimText(content, id)}</div>`).join("\n");
  return `<section class="faq">
${heading(props.titleChrome, tag)}
${items}
</section>`;
}

/**
 * Dispatches one section to its renderer. `render.ts` only ever calls this
 * after `gateSite` has reported zero blockers on content that has been
 * through `SiteContent.parse()`, so `section.type` is statically one of
 * the 8 known literals — the `never` branch below exists only to fail
 * loudly if that invariant is ever broken, not as an expected path.
 */
/** `first` marks the page's first section, whose heading is the page's one <h1>. */
export function renderSection(content: SiteContent, section: Section, env: RenderEnv, first = false): string {
  const tag: HeadingTag = first ? "h1" : "h2";
  switch (section.type) {
    case "hero":
      return renderHero(content, section.props, env, tag);
    case "feature-grid":
      return renderFeatureGrid(content, section.props, tag);
    case "roadmap-list":
      return renderRoadmapList(content, section.props, tag);
    case "changelog":
      return renderChangelog(content, section.props, tag);
    case "docs-index":
      return renderDocsIndex(content, section.props, tag);
    case "pricing-table":
      return renderPricingTable(content, section.props, tag);
    case "legal-page":
      return renderLegalPage(content, section.props, tag);
    case "faq":
      return renderFaq(content, section.props, tag);
    default: {
      const unreachable: never = section;
      throw new Error(`unknown section type: ${JSON.stringify(unreachable)}`);
    }
  }
}
