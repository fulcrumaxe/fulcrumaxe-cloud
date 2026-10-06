// ── FULCUtil — shared frontend utilities (D#240 P3.3) ───────────────────
// Consolidates two widely-duplicated patterns that had been reimplemented
// ad-hoc (and subtly inconsistently — missing quote escaping, differing
// error handling) across dozens of app files:
//
//   1. escapeHtml — HTML-escape a string for safe interpolation into
//      innerHTML/template strings.
//   2. apiJson    — fetch() + JSON parse + non-2xx error handling for
//      calls against the fulcrumaxe-os REST API.
//
// Exposed both as a `window.FULCUtil` global (for classic <script> call
// sites and quick console use) and as an ESM export (for `import` from
// sibling app/core modules).
export const FULCUtil = {};
(function () {
  'use strict';

  /**
   * Escape a string for safe interpolation into HTML markup. Escapes
   * & < > " ' — the minimum set needed to prevent breaking out of element
   * text content, double-quoted attributes, or single-quoted attributes.
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Fetch a JSON API endpoint and return the parsed response body.
   * Throws an Error on a non-2xx status — callers use a single
   * try/catch idiom instead of re-deriving status/error handling per
   * call site. The thrown message prefers a `{error}`/`{message}` field
   * from the JSON body, falling back to `"<status> <statusText>"`.
   */
  async function apiJson(url, options) {
    const resp = await fetch(url, options);
    let body = null;
    try {
      body = await resp.json();
    } catch (_e) {
      body = null;
    }
    if (!resp.ok) {
      const message =
        (body && (body.error || body.message)) || (resp.status + ' ' + resp.statusText);
      throw new Error(message);
    }
    return body;
  }

  Object.assign(FULCUtil, { escapeHtml, apiJson });
  window.FULCUtil = FULCUtil;
})();
