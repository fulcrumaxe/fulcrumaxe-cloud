import path from "node:path";
import { promises as fs } from "node:fs";
import { gateSite, type Blocker, type RenderContext, type SiteContent } from "@fx/sitekit-claims";
import { renderStylesheet, TOKEN_SETS } from "@fx/design";
import { pageOutputPath, renderPage } from "./page.js";
import type { RenderEnv } from "./assets.js";

/**
 * D#2 spec amendment (H24): the template no longer owns its own theme —
 * `packages/design` is the one source of colour, spacing and type-scale
 * values. `terminal` is the set that matches this template's own markup
 * (`.site-header`/`.site-name`/`.cta`/`.evidence`/...), which is the same
 * vocabulary `packages/design/src/css/base.css` ported those selectors
 * under.
 */
export const SITE_CSS = renderStylesheet(TOKEN_SETS.terminal);

/**
 * Thrown by `renderSite` when `gateSite` reports any blocker. Carries the
 * full blocker list and the de-duplicated claim ids involved, so a caller
 * (the build:fixture CLI, or a test) can name every blocking claim without
 * re-deriving it.
 */
export class RenderBlockedError extends Error {
  readonly blockers: Blocker[];
  readonly claimIds: string[];

  constructor(blockers: Blocker[]) {
    const ids = [...new Set(blockers.map((b) => b.claimId).filter((id): id is string => Boolean(id)))];
    super(
      `refusing to render: ${blockers.length} blocker(s) — ` +
        blockers.map((b) => `[${b.reason}]${b.claimId ? ` claim=${b.claimId}` : ""} ${b.detail}`).join("; "),
    );
    this.name = "RenderBlockedError";
    this.blockers = blockers;
    this.claimIds = ids;
  }
}

export interface RenderedPage {
  slug: string;
  outputPath: string;
  html: string;
}

export interface RenderedSite {
  pages: RenderedPage[];
  /** Every backgroundImage actually referenced while rendering: served URL -> real file on disk. */
  assets: Map<string, string>;
}

/**
 * Renders every page of `content` against a fixed, sandboxed asset root.
 *
 * D#2606 K03 constraint: calls `gateSite` FIRST and throws
 * `RenderBlockedError` — generating not one byte of HTML — if there is any
 * blocker. This is the only call to `gateSite` in the render path, and it
 * happens before `content.pages` is ever iterated, so there is no
 * "render optimistically, then check" path to accidentally take.
 *
 * `content` must already have passed `SiteContent.parse()` (or be
 * structurally equivalent) — that is what gives `section.type` its
 * compile-time exhaustive-union guarantee that `sections.ts` relies on.
 * `gateSite` is the runtime defensive boundary on top of that; it is not a
 * substitute for parsing.
 */
export function renderSite(content: SiteContent, context: RenderContext, assetRoot: string): RenderedSite {
  const blockers = gateSite(content, context);
  if (blockers.length > 0) {
    throw new RenderBlockedError(blockers);
  }

  const env: RenderEnv = { assetRoot, assets: new Map() };
  const pages: RenderedPage[] = content.pages.map((page) => ({
    slug: page.slug,
    outputPath: pageOutputPath(page),
    html: renderPage(content, page, env).html,
  }));

  return { pages, assets: env.assets };
}

/** Writes a RenderedSite to disk: one HTML file per page, every referenced
 * asset copied from the sandboxed asset root, and the shared stylesheet. */
export async function writeRenderedSite(rendered: RenderedSite, outDir: string): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  for (const page of rendered.pages) {
    const dest = path.join(outDir, page.outputPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, page.html, "utf-8");
  }

  for (const [url, absPath] of rendered.assets) {
    const dest = path.join(outDir, url.replace(/^\//, ""));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(absPath, dest);
  }

  const assetsDir = path.join(outDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(path.join(assetsDir, "site.css"), SITE_CSS, "utf-8");
}
