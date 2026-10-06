// apps/workspace/test/branding-defaults.test.mjs
//
// D#37 Correction C19d, task WS-B1 criterion 2: "The script.js:24-30
// defaults are replaced with the same six values, so a failed branding
// fetch shows the ruled text and never the jpos text.
// branding-defaults.test.mjs reads both script.js's window.brandingData
// literal and the route's body, and fails if they differ."
//
// This package (apps/workspace) has no dependency on apps/web's Next.js
// runtime, so route.ts is read and parsed as text here rather than
// imported -- apps/web/test/branding.test.ts is the other half of this
// pin, importing the route module directly and asserting the exact same
// six owner-ruled values (OWNER DECISION, 2026-09-25).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOrchardMenuBarEl } from "../shell/apps/themes/heritage/orchard-dom.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = join(TEST_DIR, "..", "..", "web", "app", "api", "branding", "route.ts");
const SCRIPT_PATH = join(TEST_DIR, "..", "shell", "script.js");
const INDEX_HTML_PATH = join(TEST_DIR, "..", "shell", "index.html");

const RULED_VALUES = {
  page_title: "fulcrumaxe",
  product_name: "fulcrumaxe cloud",
  os_name: "fulcrumaxe cloud",
  system_tag: "fulcrumaxe cloud",
  copyright: "© fulcrumaxe",
  welcome_message: "Welcome to fulcrumaxe cloud.",
};

/**
 * Extracts a flat `key: "value"` / `key: 'value'` object literal's
 * entries from source text, starting at the first `{` after `marker`
 * and ending at the next top-level `}`. Good enough for these two
 * literals (BODY in route.ts, window.brandingData in script.js), both of
 * which are flat string-valued objects with no nesting -- not a general
 * JS parser.
 */
function parseFlatObjectLiteral(sourceText, marker) {
  const markerIdx = sourceText.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`branding-defaults.test.mjs: marker not found: ${JSON.stringify(marker)}`);
  }
  const braceStart = sourceText.indexOf("{", markerIdx);
  const braceEnd = sourceText.indexOf("}", braceStart);
  const body = sourceText.slice(braceStart + 1, braceEnd);

  const entries = {};
  const entryRe = /([A-Za-z0-9_]+)\s*:\s*(["'])((?:\\.|(?!\2)[\s\S])*)\2/g;
  let match;
  while ((match = entryRe.exec(body)) !== null) {
    entries[match[1]] = match[3];
  }
  return entries;
}

describe("D#37 C19d WS-B1 criterion 2: script.js defaults match /api/branding's body", () => {
  it("window.brandingData's literal defaults equal the route's BODY, key for key", () => {
    const routeText = readFileSync(ROUTE_PATH, "utf8");
    const scriptText = readFileSync(SCRIPT_PATH, "utf8");

    const routeBody = parseFlatObjectLiteral(routeText, "const BODY = {");
    const scriptDefaults = parseFlatObjectLiteral(scriptText, "window.brandingData = {");

    expect(scriptDefaults).toEqual(routeBody);
  });

  it("both sides pin the exact six owner-ruled values (OWNER DECISION, 2026-09-25)", () => {
    const routeText = readFileSync(ROUTE_PATH, "utf8");
    const scriptText = readFileSync(SCRIPT_PATH, "utf8");

    expect(parseFlatObjectLiteral(routeText, "const BODY = {")).toEqual(RULED_VALUES);
    expect(parseFlatObjectLiteral(scriptText, "window.brandingData = {")).toEqual(RULED_VALUES);
  });
});

// D#37 Correction C20 (discussioncomment-18616362), task WS-B2 criterion 1:
// "index.html's static markup (`<span class="system-tag"
// id="dynamic-system-tag">fulcrumaxe-os SYSTEM</span>`) is changed to the
// WS-B1 ruled default, `fulcrumaxe cloud`... A test asserts the pre-fetch,
// static HTML text of `#dynamic-system-tag` equals `fulcrumaxe cloud`, not
// only the post-`fetchBranding()` value `branding.spec.ts` already covers."
//
// This reads index.html's raw source, never a rendered DOM, so it catches
// exactly the static-markup regression branding.spec.ts's Playwright
// `toHaveText` assertion cannot: that assertion retries until
// fetchBranding() resolves and overwrites the span, so it passes even if
// the pre-fetch fallback text were still the removed jpos string.
describe("D#37 C20 WS-B2 criterion 1: index.html's static #dynamic-system-tag matches the WS-B1 default", () => {
  it("the static span text equals the ruled system_tag, not the jpos default", () => {
    const html = readFileSync(INDEX_HTML_PATH, "utf8");
    const match = html.match(/<span class="system-tag" id="dynamic-system-tag">([^<]*)<\/span>/);
    expect(match, "could not find #dynamic-system-tag in index.html").not.toBeNull();
    expect(match[1]).toBe(RULED_VALUES.system_tag);
  });
});

// D#37 Correction C20, task WS-B2 criterion 2: "orchard-dom.js's
// buildOrchardMenuBarEl() no longer hardcodes appname.textContent =
// 'fulcrumaxe-os'. It reads the same branding value the boot sequence uses
// (window.brandingData.product_name or os_name), falling back to the
// WS-B1 default if branding hasn't loaded."
//
// apps/workspace's vitest environment is "node" (see heritage-shell.test.mjs's
// header comment), not jsdom. buildOrchardMenuBarEl only ever calls
// document.createElement/createElementNS, .setAttribute and .appendChild on
// the nodes it creates -- a minimal stub element (plain object, arbitrary
// property assignment, an appendChild that records children) is enough to
// exercise the real module and inspect its output, exactly like
// heritage-shell.test.mjs's stub `document`.
function makeStubElement() {
  return {
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
  };
}

function findById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

describe("D#37 C20 WS-B2 criterion 2: orchard menubar app name reflects branding, not a literal string", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    globalThis.document = {
      createElement: () => makeStubElement(),
      createElementNS: () => makeStubElement(),
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    delete globalThis.document;
  });

  it("uses window.brandingData.product_name when branding has loaded", () => {
    globalThis.window = { brandingData: { product_name: "Acme Cloud", os_name: "Acme OS" } };
    const appname = findById(buildOrchardMenuBarEl(), "orchard-appname");
    expect(appname.textContent).toBe("Acme Cloud");
  });

  it("falls back to os_name when product_name is absent", () => {
    globalThis.window = { brandingData: { os_name: "Acme OS Only" } };
    const appname = findById(buildOrchardMenuBarEl(), "orchard-appname");
    expect(appname.textContent).toBe("Acme OS Only");
  });

  it("falls back to the WS-B1 ruled default when branding hasn't loaded, never the literal jpos string", () => {
    delete globalThis.window;
    const appname = findById(buildOrchardMenuBarEl(), "orchard-appname");
    expect(appname.textContent).toBe(RULED_VALUES.product_name);
    expect(appname.textContent).not.toBe("fulcrumaxe-os");
  });
});
