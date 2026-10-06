import type { CheckResult } from "../types.js";
import { asRecords, clip, evaluateAudit, runOnPages, type BrowserPagesOptions } from "./browser-pages.js";

/**
 * Port of the audit in os-site-v2/tools/check-render.mjs: render every page at each viewport (and theme) and
 * check what a reader would see. The CDP plumbing is gone: the browser comes in through `options.driver`.
 */
export interface RenderOptions extends BrowserPagesOptions {
  /** Viewport widths in px. Default [390, 1280]. A width under 500 is a phone (`mobile: true`). */
  viewports?: number[];
  /** Themes, each an attribute on <html> and the values to render it with. Default none: one pass, as authored. */
  themes?: { attr: string; values: string[] }[];
}

/**
 * Runs in the page. Computed from getComputedStyle, not the stylesheet: the question is what a reader sees.
 * A text node scores AA against the first opaque background behind it (black when there is none).
 */
const AUDIT = String.raw`() => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const ratio = (fg, bg) => { const a = lum(fg) + 0.05, b = lum(bg) + 0.05; return a > b ? a / b : b / a; };
  const sel = (el) => el.tagName.toLowerCase()
    + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const behind = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.95) return c.rgb;
    }
    const root = parse(getComputedStyle(document.documentElement).backgroundColor);
    return root && root.a > 0.95 ? root.rgb : [0, 0, 0];
  };
  const contrast = [], seen = new Set();
  for (const el of document.querySelectorAll('main *, footer *, nav *')) {
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.1 || parseFloat(cs.fontSize) < 4) continue;
    const box = el.getBoundingClientRect();
    const fg = parse(cs.color);
    if (!box.width || !box.height || !fg || fg.a < 0.5) continue;
    const size = parseFloat(cs.fontSize);
    const need = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700) ? 3 : 4.5;
    const r = ratio(fg.rgb, behind(el));
    const key = sel(el) + '|' + cs.color + '|' + Math.round(size);
    if (r + 0.05 < need && !seen.has(key)) {
      seen.add(key);
      contrast.push({ selector: sel(el), ratio: Math.round(r * 100) / 100, need });
    }
  }
  const overflow = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.right <= window.innerWidth + 1 || box.width <= 8) continue;
      let scroller = /auto|scroll/.test(getComputedStyle(el).overflowX);
      for (let p = el.parentElement; p && !scroller; p = p.parentElement) scroller = /auto|scroll/.test(getComputedStyle(p).overflowX);
      if (!scroller) overflow.push({ selector: sel(el), right: Math.round(box.right) });
    }
  }
  const wrapped = [];
  for (const a of document.querySelectorAll('.nav-links a')) {
    if (a.getClientRects().length > 1) wrapped.push({ selector: '.nav-links a', text: a.textContent.trim().slice(0, 24) });
  }
  const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
  const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor);
  return {
    contrast: contrast.slice(0, 6), overflow: overflow.slice(0, 3), wrapped: wrapped.slice(0, 3),
    unpainted: (!bodyBg || bodyBg.a < 0.95) && (!rootBg || rootBg.a < 0.95),
  };
}`;

/** Stops a colour transition mid-flight from being read as the colour a theme ends on. */
const FREEZE = String.raw`() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(s);
  return true;
}`;

const THEME = "(t) => { document.documentElement.setAttribute(t.attr, t.value); return true; }";

export async function run(renderedDir: string, options: RenderOptions = {}): Promise<CheckResult> {
  const viewports = options.viewports ?? [390, 1280];
  const passes = (options.themes ?? []).flatMap((t) => t.values.map((value) => ({ attr: t.attr, value })));
  if (passes.length === 0) passes.push({ attr: "", value: "" });

  return runOnPages(renderedDir, options, ["/404.html"], async ({ page, load, fail }) => {
    let renders = 0;
    for (const width of viewports) {
      await page.setViewport({ width, height: 900, mobile: width < 500 });
      for (const theme of passes) {
        renders++;
        if (!(await load())) continue;
        await evaluateAudit(page, FREEZE);
        if (theme.attr) await evaluateAudit(page, THEME, theme);
        const audit = asRecords([await evaluateAudit(page, AUDIT)])[0] as Record<string, unknown>;
        const at = { viewport: width };
        const tag = theme.attr ? ` [${theme.attr}=${clip(theme.value, 30)}]` : "";
        if (audit.unpainted === true) {
          fail("unpainted", `body has no opaque background${tag}`, "Give body or html a background-colour.", at);
        }
        for (const w of asRecords(audit.wrapped)) {
          fail("nav_label_wrapped", `nav label breaks across lines: "${clip(String(w.text), 24)}"${tag}`, "Shorten the label or widen its slot.", { ...at, selector: String(w.selector) });
        }
        for (const o of asRecords(audit.overflow)) {
          fail("overflow", `scrolls sideways: reaches ${Number(o.right)}px in a ${width}px viewport${tag}`, "Constrain this element's width, or let it scroll inside its own container.", { ...at, selector: String(o.selector) });
        }
        for (const c of asRecords(audit.contrast)) {
          fail("contrast", `contrast ${Number(c.ratio)}:1, needs ${Number(c.need)}:1${tag}`, "Pick a text or background colour that reaches the needed ratio.", { ...at, selector: String(c.selector) });
        }
      }
    }
    return renders;
  });
}
