// ── Crystal Heritage Icons ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// D#37 WS-TH1 (C19b criterion 2): declarative shape data, not markup
// strings. The old table held raw `<svg>...</svg>` strings that
// crystal-dom.js assigned via `.innerHTML` -- a Trusted Types
// sink under the enforced `require-trusted-types-for 'script'` policy.
// DOMParser is ruled out by name (C19b, C18b criterion 3): it requires a
// TrustedHTML under `trusted-types 'none'` and would throw either way.
// buildCrystalIcon() below builds a live <svg> node with createElementNS
// instead, so stroke/fill="currentColor" still tracks the surrounding CSS
// `color` the way the old inline markup did (an <img>-loaded external SVG
// can't do that -- its content sits in a separate document with no access
// to the page's computed color).
const SVG_NS = "http://www.w3.org/2000/svg";

export const CrystalIcons = {
  terminal: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "rect", attrs: { x: "3", y: "5", width: "22", height: "18", rx: "3", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M8 11l4 3-4 3", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" } }, { tag: "path", attrs: { d: "M14 17h6", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }] },
  themes: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "circle", attrs: { cx: "14", cy: "14", r: "9", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M14 5v18M5 14h18", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", opacity: "0.4" } }, { tag: "circle", attrs: { cx: "14", cy: "14", r: "3", fill: "currentColor" } }] },
  "file-manager": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "path", attrs: { d: "M5 9a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9z", stroke: "currentColor", "stroke-width": "1.5" } }] },
  kanban: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "rect", attrs: { x: "4", y: "5", width: "5", height: "18", rx: "2", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "rect", attrs: { x: "11.5", y: "5", width: "5", height: "12", rx: "2", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "rect", attrs: { x: "19", y: "5", width: "5", height: "8", rx: "2", stroke: "currentColor", "stroke-width": "1.5" } }] },
  agents: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "circle", attrs: { cx: "14", cy: "10", r: "4", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M6 23c0-4.4 3.6-8 8-8s8 3.6 8 8", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }, { tag: "circle", attrs: { cx: "20", cy: "8", r: "2.5", fill: "currentColor", opacity: "0.6" } }] },
  "package-manager": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "rect", attrs: { x: "5", y: "12", width: "18", height: "12", rx: "2", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M9 12V9a5 5 0 0 1 10 0v3", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }, { tag: "path", attrs: { d: "M11 17h6", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }] },
  "kpi-dashboard": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "path", attrs: { d: "M5 20l5-5 4 3 5-7 4 3", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" } }] },
  messages: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "path", attrs: { d: "M5 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5l-4 4v-4H7a2 2 0 0 1-2-2V7z", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round" } }] },
  profile: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "circle", attrs: { cx: "14", cy: "10", r: "5", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M5 24c0-5 4-9 9-9s9 4 9 9", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }] },
  "resource-monitor": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "rect", attrs: { x: "3", y: "4", width: "22", height: "16", rx: "2", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M7 24h14M14 20v4", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }, { tag: "path", attrs: { d: "M7 14l3-4 3 6 3-8 3 4", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" } }] },
  "storage-manager": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "ellipse", attrs: { cx: "14", cy: "8", rx: "9", ry: "3", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M5 8v12c0 1.7 4 3 9 3s9-1.3 9-3V8", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M5 14c0 1.7 4 3 9 3s9-1.3 9-3", stroke: "currentColor", "stroke-width": "1.5" } }] },
  "command-builder": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "rect", attrs: { x: "4", y: "6", width: "20", height: "16", rx: "2", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M8 12l3 2-3 2M13 16h7", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" } }] },
  "shortcut-trainer": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "rect", attrs: { x: "4", y: "8", width: "8", height: "6", rx: "1.5", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "rect", attrs: { x: "16", y: "8", width: "8", height: "6", rx: "1.5", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "rect", attrs: { x: "8", y: "17", width: "12", height: "4", rx: "1.5", stroke: "currentColor", "stroke-width": "1.5" } }] },
  tutorial: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "path", attrs: { d: "M5 6h18M5 12h12M5 18h8", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }, { tag: "circle", attrs: { cx: "21", cy: "19", r: "4", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M21 17v4M19 19h4", stroke: "currentColor", "stroke-width": "1", "stroke-linecap": "round", opacity: "0.7" } }] },
  admin: { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "path", attrs: { d: "M14 4l8 3v6c0 5-4 9-8 11C10 22 6 18 6 13V7l8-3z", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round" } }] },
  "fulc-shell": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "circle", attrs: { cx: "14", cy: "14", r: "10", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M10 11l3 3-3 3M15 17h3", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" } }] },
  "key-trainer": { viewBox: "0 0 28 28", fill: "none", shapes: [{ tag: "circle", attrs: { cx: "11", cy: "12", r: "5", stroke: "currentColor", "stroke-width": "1.5" } }, { tag: "path", attrs: { d: "M15 15l8 8", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }, { tag: "path", attrs: { d: "M19 19l2-2M21 23v-2h2", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" } }] },
};

function buildShapeEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const key in attrs) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) el.setAttribute(key, attrs[key]);
  }
  return el;
}

/** Build a live <svg> DOM node for `appId`, or `null` if it has no icon. */
export function buildCrystalIcon(appId) {
  const def = Object.prototype.hasOwnProperty.call(CrystalIcons, appId) ? CrystalIcons[appId] : null;
  if (!def) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", def.viewBox);
  svg.setAttribute("fill", def.fill);
  for (const shape of def.shapes) svg.appendChild(buildShapeEl(shape.tag, shape.attrs));
  return svg;
}

/** Look up an icon's raw shape data by app id, or `null` if not registered. */
export function getCrystalIcon(appId) {
  return Object.prototype.hasOwnProperty.call(CrystalIcons, appId) ? CrystalIcons[appId] : null;
}
