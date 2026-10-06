// ── fulcrumaxe-os Modal System ────────────────────────────────────────────────
// Replaces native alert(), confirm(), prompt() with themed fulcrumaxe-os modals.
// Exposes (as window globals for app-level ergonomics): fulcAlert, fulcConfirm,
// fulcPrompt. The FULCModals surface (toast) is exported for ESM consumers.
// Static import (not `window.FULCNotify`) so the toast stack is guaranteed
// initialised before the first `FULCModals.toast` call, independent of where
// index.html happens to place the two <script> tags.
import { FULCNotify } from './notifications.js';
export const FULCModals = {};
(function () {
  'use strict';

  // ── Create modal container ───────────────────────────────────────────

  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'fulc-modal-overlay';
  modalOverlay.className = 'fulc-modal-overlay hidden';
  const modalEl = document.createElement('div');
  modalEl.className = 'fulc-modal';
  modalEl.id = 'fulc-modal';
  modalOverlay.appendChild(modalEl);
  document.body.appendChild(modalOverlay);

  let resolveCallback = null;

  // Trusted-Types-safe replacement for the old markup-string sink: takes a
  // DOM node (built by the caller with createElement / textContent, never
  // an HTML string) and swaps it in directly.
  function showModal(bodyNode) {
    // dom-insert-ok: every caller in this file passes a body element it just built with createElement
    modalEl.replaceChildren(bodyNode);
    modalOverlay.classList.remove('hidden');
    // Focus first input or button
    const focusTarget = modalEl.querySelector('input, button');
    if (focusTarget) setTimeout(() => focusTarget.focus(), 50);
  }

  function hideModal(value) {
    modalOverlay.classList.add('hidden');
    modalEl.replaceChildren();
    if (resolveCallback) {
      resolveCallback(value);
      resolveCallback = null;
    }
  }

  // Stop all events from reaching other handlers
  modalOverlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') hideModal(null);
  });
  modalOverlay.addEventListener('mousedown', (e) => {
    if (e.target === modalOverlay) hideModal(null);
  });

  // Text set via `.textContent` never needs HTML-escaping (the browser
  // never parses it as markup), but `null`/`undefined` must still render
  // as an empty string to match the old `escapeHtml()`-based behaviour.
  function safeText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  // ── Alert (replaces alert()) ─────────────────────────────────────────

  window.fulcAlert = function (message) {
    return new Promise((resolve) => {
      resolveCallback = resolve;

      const body = document.createElement('div');
      body.className = 'fulc-modal-body';

      const p = document.createElement('p');
      p.className = 'fulc-modal-message';
      p.textContent = safeText(message);
      body.appendChild(p);

      const actions = document.createElement('div');
      actions.className = 'fulc-modal-actions';
      const okBtn = document.createElement('button');
      okBtn.className = 'fulc-modal-btn fulc-modal-btn-primary';
      okBtn.id = 'fulc-modal-ok';
      okBtn.textContent = 'OK';
      actions.appendChild(okBtn);
      body.appendChild(actions);

      showModal(body);
      okBtn.onclick = () => hideModal(true);
      okBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') hideModal(true);
      });
    });
  };

  // ── Confirm (replaces confirm()) ─────────────────────────────────────

  window.fulcConfirm = function (message) {
    return new Promise((resolve) => {
      resolveCallback = resolve;

      const body = document.createElement('div');
      body.className = 'fulc-modal-body';

      const p = document.createElement('p');
      p.className = 'fulc-modal-message';
      p.textContent = safeText(message);
      body.appendChild(p);

      const actions = document.createElement('div');
      actions.className = 'fulc-modal-actions';
      const yesBtn = document.createElement('button');
      yesBtn.className = 'fulc-modal-btn fulc-modal-btn-primary';
      yesBtn.id = 'fulc-modal-yes';
      yesBtn.textContent = 'YES';
      const noBtn = document.createElement('button');
      noBtn.className = 'fulc-modal-btn';
      noBtn.id = 'fulc-modal-no';
      noBtn.textContent = 'NO';
      actions.appendChild(yesBtn);
      actions.appendChild(noBtn);
      body.appendChild(actions);

      showModal(body);
      yesBtn.onclick = () => hideModal(true);
      noBtn.onclick = () => hideModal(false);
    });
  };

  // ── Prompt (replaces prompt()) ───────────────────────────────────────

  window.fulcPrompt = function (message, defaultValue, options) {
    const opts = options || {};
    const inputType = opts.type || 'text';
    const placeholder = opts.placeholder || '';

    return new Promise((resolve) => {
      resolveCallback = resolve;

      const body = document.createElement('div');
      body.className = 'fulc-modal-body';

      const p = document.createElement('p');
      p.className = 'fulc-modal-message';
      p.textContent = safeText(message);
      body.appendChild(p);

      const input = document.createElement('input');
      input.type = inputType;
      input.className = 'fulc-modal-input';
      input.id = 'fulc-modal-input';
      input.value = safeText(defaultValue);
      input.setAttribute('placeholder', safeText(placeholder));
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      body.appendChild(input);

      const actions = document.createElement('div');
      actions.className = 'fulc-modal-actions';
      const submitBtn = document.createElement('button');
      submitBtn.className = 'fulc-modal-btn fulc-modal-btn-primary';
      submitBtn.id = 'fulc-modal-submit';
      submitBtn.textContent = 'OK';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'fulc-modal-btn';
      cancelBtn.id = 'fulc-modal-cancel';
      cancelBtn.textContent = 'CANCEL';
      actions.appendChild(submitBtn);
      actions.appendChild(cancelBtn);
      body.appendChild(actions);

      showModal(body);

      const submit = () => hideModal(input.value);
      const cancel = () => hideModal(null);

      submitBtn.onclick = submit;
      cancelBtn.onclick = cancel;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') cancel();
      });
    });
  };

  // D#37 WS-C2 criterion 9: the fork's shipped bytes contain no
  // password-shaped input of any kind. The upstream
  // `window.fulcPasswordPrompt` helper (a thin wrapper over fulcPrompt()
  // that requested a masked field) had no caller anywhere in the
  // imported shell tree -- removed rather than left as unreachable dead
  // code that would otherwise trip a checks.mjs --ship rule.

  // ── Toast (compatibility shim) ─────────────────────────────────────────
  //
  // epic-16 task 01: the toast implementation now lives in
  // `core/notifications.js`. This wrapper stays because ~26 call sites across
  // kanban, app-store, and the terminal already speak `toast(message,
  // duration)`; re-pointing it migrates all of them at once, with no call-site
  // edits and no signature change.
  //
  // The behaviour it replaced had a real defect: it ran
  // `document.querySelector('.fulc-toast').remove()` on every call, so a
  // second message within the display window silently destroyed the first
  // before it could be read. FULCNotify stacks instead (max 5, oldest
  // evicted). Two other differences are intentional and visible: toasts now
  // render bottom-right rather than bottom-centre, and they are clickable to
  // dismiss rather than `pointer-events: none`.
  //
  // New code should call `window.FULCNotify` directly — severity, actions and
  // a dismiss handle do not fit through this signature.

  Object.assign(FULCModals, {
    toast: function (message, duration) {
      FULCNotify.notify(String(message), duration || 2000);
    }
  });
})();
