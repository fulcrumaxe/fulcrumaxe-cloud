// ── Branding Applier — epic-7 task 11b (D#192) ───────────────────────
// Applies gateway-stored branding overrides at boot for ALL profiles
// (not skeleton-gated). Called after /api/branding is fetched.
//
// Responsibilities:
//   1. Apply color_palette as CSS custom-property overrides on :root
//   2. Render logo (if present) on the login/boot screen
//   3. Set document.title from product_name
//
// CSS-injection safety: values are applied only as CSS custom property
// values (--var: value) on :root via style.setProperty, never as
// innerHTML or style text. The gateway already validates that all color
// values are CSS-safe hex/named colors before storing them.
//
// SVG safety: logo img src is set via element.src — the browser renders
// the SVG through its <img> sandbox, which prevents script execution.
// (The gateway also serves SVG with Content-Disposition: attachment.)
(function () {
  'use strict';

  /**
   * Apply a color_palette object as CSS custom properties on :root.
   * Only runs when the palette is a non-empty object with string values.
   *
   * @param {Record<string, string>} palette
   */
  function applyColorPalette(palette) {
    if (!palette || typeof palette !== 'object') return;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(palette)) {
      // Restrict to CSS variable names and simple values.
      // The gateway already validates these; belt-and-suspenders here.
      if (typeof key !== 'string' || typeof value !== 'string') continue;
      if (!key.trim() || !value.trim()) continue;
      // Only apply CSS custom properties (--name) or allow-listed var names.
      // Reject anything that doesn't look like a CSS var name or safe color.
      if (!(/^--[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key))) {
        console.warn('[branding-applier] skipping invalid CSS var key:', key);
        continue;
      }
      // Ensure the value is CSS-safe: hex, named color, or empty.
      // CSS custom property values are opaque to the browser until used, so
      // this guard prevents arbitrary CSS from leaking into properties that
      // get used in calc() / var() expressions.
      const safe = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
        || /^[a-zA-Z-]+$/.test(value);
      if (!safe) {
        console.warn('[branding-applier] skipping unsafe color value for', key, ':', value);
        continue;
      }
      const cssKey = key.startsWith('--') ? key : '--' + key;
      root.style.setProperty(cssKey, value);
    }
  }

  /**
   * Render the logo image on the login/boot screen.
   * Inserts an <img> before the boot log (or in the logo placeholder if present).
   *
   * @param {string} logoUrl
   */
  function applyLogo(logoUrl) {
    if (!logoUrl || typeof logoUrl !== 'string') return;
    // Look for an existing logo placeholder first.
    let placeholder = document.getElementById('fulc-logo-placeholder');
    if (!placeholder) {
      // Fall back to inserting before the boot log.
      placeholder = document.getElementById('boot-log');
      if (!placeholder) return;
      const wrapper = document.createElement('div');
      wrapper.id = 'fulc-logo-placeholder';
      wrapper.className = 'fulc-boot-logo';
      placeholder.parentNode.insertBefore(wrapper, placeholder);
      placeholder = wrapper;
    }

    // Only insert once
    if (placeholder.querySelector('img.fulc-custom-logo')) return;

    const img = document.createElement('img');
    img.className = 'fulc-custom-logo';
    img.alt = 'Brand logo';
    img.style.maxHeight = '80px';
    img.style.maxWidth = '200px';
    img.style.margin = '8px auto';
    img.style.display = 'block';
    img.src = logoUrl;  // SVG safety: set via src, not innerHTML
    placeholder.appendChild(img);
  }

  /**
   * Apply all branding fields from the /api/branding response.
   * Called by boot.js after fetchBranding() completes and sets window.brandingData.
   *
   * @param {object} branding  — the parsed /api/branding response
   */
  function applyBranding(branding) {
    if (!branding) return;

    // document.title and system tag are already handled by boot.js;
    // we extend with color_palette and logo.
    try {
      if (branding.color_palette && typeof branding.color_palette === 'object') {
        applyColorPalette(branding.color_palette);
      }
    } catch (e) {
      console.warn('[branding-applier] color_palette apply failed:', e);
    }

    try {
      if (branding.logo_url) {
        applyLogo(branding.logo_url);
      }
    } catch (e) {
      console.warn('[branding-applier] logo apply failed:', e);
    }
  }

  // Expose globally so boot.js can call applyBranding(window.brandingData)
  // after fetchBranding() resolves, and so the Branding tab's Save+preview
  // flow can call it directly.
  window.FULCBrandingApplier = { applyBranding, applyColorPalette, applyLogo };

})();
