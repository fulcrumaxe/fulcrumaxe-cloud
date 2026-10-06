import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as html from "../src/html/index.js";
import * as react from "../src/react/index.js";

/**
 * D#2 spec amendment pass/fail item 4: no framework-only assumption — the
 * same component renders through src/html (a string) and src/react, and
 * the two outputs must normalize to the same markup and class names.
 *
 * "Normalize" here means: collapse whitespace between tags (the string
 * renderer sometimes joins pieces with "\n", renderToStaticMarkup never
 * does) and nothing else — attribute order, quoting and boolean-attribute
 * form are made to match exactly in the renderers themselves (see
 * src/html/index.ts's note on `disabled=""`), not papered over here.
 */
function normalize(markup: string): string {
  return markup.replace(/>\s+</g, "><").trim();
}

describe("html/react parity (D#2 spec amendment item 4)", () => {
  it("Header: same markup and classes", () => {
    const props = {
      siteName: "Example",
      links: [
        { label: "Docs", href: "/docs" },
        { label: "Pricing", href: "/pricing", current: true },
      ],
    };
    expect(normalize(html.header(props))).toBe(normalize(renderToStaticMarkup(<react.Header {...props} />)));
  });

  it("Footer: same markup and classes", () => {
    const props = { creditText: "Built with fulcrumaxe", links: [{ label: "Docs", href: "/docs" }] };
    expect(normalize(html.footer(props))).toBe(normalize(renderToStaticMarkup(<react.Footer {...props} />)));
  });

  it("Footer with no links: same markup and classes", () => {
    const props = { creditText: "Built with fulcrumaxe" };
    expect(normalize(html.footer(props))).toBe(normalize(renderToStaticMarkup(<react.Footer {...props} />)));
  });

  it("Button (link, primary): same markup and classes", () => {
    const props = { label: "Get started", href: "/start", variant: "primary" as const };
    expect(normalize(html.button(props))).toBe(normalize(renderToStaticMarkup(<react.Button {...props} />)));
  });

  it("Button (disabled, no href): same markup and classes", () => {
    const props = { label: "Unavailable", disabled: true };
    expect(normalize(html.button(props))).toBe(normalize(renderToStaticMarkup(<react.Button {...props} />)));
  });

  it("EvidenceLink: same markup and classes", () => {
    const props = { label: "src/foo.ts#L1-L3", href: "https://example.com/foo.ts#L1-L3" };
    expect(normalize(html.evidenceLink(props))).toBe(
      normalize(renderToStaticMarkup(<react.EvidenceLink {...props} />)),
    );
  });

  it("Card: same markup and classes", () => {
    const props = { label: "Feature", title: "Ships fast", body: "One package, one style.", href: "/features" };
    expect(normalize(html.card(props))).toBe(normalize(renderToStaticMarkup(<react.Card {...props} />)));
  });

  it("CodeBlock: same markup and classes", () => {
    const props = { label: "install", code: "pnpm add @fx/design" };
    expect(normalize(html.codeBlock(props))).toBe(normalize(renderToStaticMarkup(<react.CodeBlock {...props} />)));
  });

  it("StateMessage (error): same markup and classes", () => {
    const props = { variant: "error" as const, message: "Could not load that page." };
    expect(normalize(html.stateMessage(props))).toBe(
      normalize(renderToStaticMarkup(<react.StateMessage {...props} />)),
    );
  });

  it("StateMessage (loading): same markup and classes", () => {
    const props = { variant: "loading" as const, message: "Loading…" };
    expect(normalize(html.stateMessage(props))).toBe(
      normalize(renderToStaticMarkup(<react.StateMessage {...props} />)),
    );
  });
});
