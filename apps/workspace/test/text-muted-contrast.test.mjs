// apps/workspace/test/text-muted-contrast.test.mjs
//
// a11y: --text-muted is the colour of the Pipeline's .pl-muted lines and .pl-kind tag and of muted text in the
// other apps. WCAG 2.2 AA (1.4.3) needs 4.5:1 for normal text. Every place the token is defined is checked
// against the surface tokens it can sit on: the shipped theme JSON files (against their own surfaces) and the
// legacy token blocks in shell/style.css and shell/core/theme-manager.js (against the :root surfaces, which
// those blocks do not override). The ratio is computed the WCAG way: the translucent colour is composited
// over the surface first.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AA = 4.5;
const SURFACES = ["bg-base", "bg-surface", "bg-elevated"];

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

function parseColor(s) {
  const t = s.trim();
  let m = t.match(/^#([0-9a-f]{6})$/i);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = t.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error("unparseable colour: " + s);
}

function contrast(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  expect(b.a, `surface ${bg} must be opaque`).toBe(1);
  const out = f.rgb.map((v, i) => v * f.a + b.rgb[i] * (1 - f.a));
  const [hi, lo] = [lum(out), lum(b.rgb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every definition of the token: { name, muted, secondary, surfaces: {token: colour} }
function definitions() {
  const out = [];
  const profile = JSON.parse(readFileSync(join(ROOT, "profiles", "cloud.json"), "utf8"));
  const excluded = new Set(profile.excluded_themes || []);
  const dir = join(ROOT, "shell", "core", "themes");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const id = f.replace(/\.json$/, "");
    if (excluded.has(id)) continue;
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const find = (o, k) => {
      if (o && typeof o === "object") {
        if (typeof o[k] === "string") return o[k];
        for (const v of Object.values(o)) { const r = find(v, k); if (r) return r; }
      }
      return undefined;
    };
    out.push({
      name: `theme ${id}`,
      muted: find(j, "text-muted"),
      secondary: find(j, "text-secondary"),
      surfaces: Object.fromEntries(SURFACES.map((k) => [k, find(j, k)])),
    });
  }

  const css = readFileSync(join(ROOT, "shell", "style.css"), "utf8");
  const rootBlock = css.match(/:root\s*\{([^}]*)\}/)[1];
  const rootSurfaces = Object.fromEntries(
    SURFACES.map((k) => [k, rootBlock.match(new RegExp(`--${k}:\\s*(#[0-9a-fA-F]{6})`))[1]]),
  );
  const block = /([^{}]+)\{([^{}]*--text-muted:[^{}]*)\}/g;
  for (let m; (m = block.exec(css)); ) {
    const sel = m[1].trim().split("\n").pop().trim();
    out.push({
      name: `style.css ${sel}`,
      muted: m[2].match(/--text-muted:\s*([^;]+);/)[1],
      secondary: (m[2].match(/--text-secondary:\s*([^;]+);/) || [])[1],
      surfaces: rootSurfaces,
    });
  }

  const tm = readFileSync(join(ROOT, "shell", "core", "theme-manager.js"), "utf8");
  const legacy = /'([a-z]+)':\s*\{[^}]*'text-secondary':\s*'([^']+)'[^}]*'text-muted':\s*'([^']+)'/g;
  for (let m; (m = legacy.exec(tm)); ) {
    out.push({ name: `theme-manager legacy ${m[1]}`, muted: m[3], secondary: m[2], surfaces: rootSurfaces });
  }
  return out;
}

describe("--text-muted contrast (WCAG 2.2 AA 1.4.3)", () => {
  const defs = definitions();

  it("finds every definition (guards against the scan going blind)", () => {
    // 8 shipped theme files, 6 style.css blocks (:root + 5 legacy), 2 theme-manager overrides.
    expect(defs.filter((d) => d.name.startsWith("theme ")).length).toBe(8);
    expect(defs.filter((d) => d.name.startsWith("style.css")).length).toBe(6);
    expect(defs.filter((d) => d.name.startsWith("theme-manager")).length).toBe(2);
  });

  for (const d of definitions()) {
    it(`${d.name}: muted text is at least ${AA}:1 on every surface`, () => {
      for (const s of SURFACES) {
        expect(d.surfaces[s], `${d.name} ${s}`).toBeTruthy();
        expect(contrast(d.muted, d.surfaces[s]), `${d.name} ${d.muted} on ${s} ${d.surfaces[s]}`).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`${d.name}: muted still reads as secondary (less contrast than text-secondary)`, () => {
      if (!d.secondary) return;
      for (const s of SURFACES) {
        expect(contrast(d.muted, d.surfaces[s])).toBeLessThan(contrast(d.secondary, d.surfaces[s]));
      }
    });
  }
});
