// ── fulcrumaxe-os Keybindings System ──────────────────────────────────────────
// Remappable keyboard shortcuts for the editor, stored in localStorage.
// Exports FULCKeys { open, match, labelFor, ... } for module consumers.
// D#37 WS-C2 fix round item 3 (W2, CWE-359): persisted under
// storage-ns.js's fx:<ns>: namespace, not a raw localStorage key -- see
// core/hot-corners.js for the same load-now/reload-on-namespace pattern
// this file mirrors.
import { getItem, setItem, onNamespaceReady } from "./core/storage-ns.js";

export const FULCKeys = {};
(function () {
  'use strict';

  const STORAGE_KEY = 'fulc_keybindings';

  // ── Default bindings ─────────────────────────────────────────────────
  // Each entry: { action, label, key, ctrl, shift, alt }
  // key uses KeyboardEvent.key values (lowercase)

  const DEFAULTS = [
    { action: 'save',       label: 'SAVE',           key: 's',         ctrl: true,  shift: false, alt: false },
    { action: 'exit',       label: 'EXIT',           key: 'x',         ctrl: true,  shift: false, alt: false },
    { action: 'saveExit',   label: 'SAVE & EXIT',    key: 'q',         ctrl: true,  shift: false, alt: false },
    { action: 'find',       label: 'FIND & REPLACE', key: 'f',         ctrl: true,  shift: false, alt: false },
    { action: 'goToLine',   label: 'GO TO LINE',     key: 'g',         ctrl: true,  shift: false, alt: false },
    { action: 'dupLine',    label: 'DUPLICATE LINE',  key: 'd',         ctrl: true,  shift: false, alt: false },
    { action: 'delLine',    label: 'DELETE LINE',     key: 'k',         ctrl: true,  shift: true,  alt: false },
    { action: 'moveUp',     label: 'MOVE LINE UP',    key: 'ArrowUp',   ctrl: false, shift: false, alt: true },
    { action: 'moveDown',   label: 'MOVE LINE DOWN',  key: 'ArrowDown', ctrl: false, shift: false, alt: true },
    { action: 'comment',    label: 'TOGGLE COMMENT',  key: '/',         ctrl: true,  shift: false, alt: false },
    { action: 'keybindings',label: 'KEYBINDINGS',     key: ',',         ctrl: true,  shift: false, alt: false },
  ];

  // ── State ────────────────────────────────────────────────────────────

  let bindings = loadBindings();
  onNamespaceReady(() => { bindings = loadBindings(); });
  let listeningAction = null; // which action is waiting for a new key

  function loadBindings() {
    try {
      const saved = JSON.parse(getItem(STORAGE_KEY));
      if (saved && typeof saved === 'object') {
        // Merge saved over defaults (keeps new actions from updates)
        return DEFAULTS.map(def => {
          const override = saved[def.action];
          if (override) {
            return { ...def, key: override.key, ctrl: !!override.ctrl, shift: !!override.shift, alt: !!override.alt };
          }
          return { ...def };
        });
      }
    } catch (e) {}
    return DEFAULTS.map(d => ({ ...d }));
  }

  function saveBindings() {
    const obj = {};
    bindings.forEach(b => {
      obj[b.action] = { key: b.key, ctrl: b.ctrl, shift: b.shift, alt: b.alt };
    });
    setItem(STORAGE_KEY, JSON.stringify(obj));
  }

  function getBinding(action) {
    return bindings.find(b => b.action === action);
  }

  function getDefault(action) {
    return DEFAULTS.find(d => d.action === action);
  }

  // ── Matching ─────────────────────────────────────────────────────────

  function match(e, action) {
    const b = getBinding(action);
    if (!b) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    return (
      e.key.toLowerCase() === b.key.toLowerCase() &&
      ctrl === b.ctrl &&
      e.shiftKey === b.shift &&
      e.altKey === b.alt
    );
  }

  // ── Display helpers ──────────────────────────────────────────────────

  function formatKey(b) {
    const parts = [];
    if (b.ctrl) parts.push('Ctrl');
    if (b.shift) parts.push('Shift');
    if (b.alt) parts.push('Alt');

    let keyName = b.key;
    const keyMap = {
      'arrowup': '↑', 'arrowdown': '↓', 'arrowleft': '←', 'arrowright': '→',
      ' ': 'Space', 'escape': 'Esc', 'enter': 'Enter', 'backspace': 'Bksp',
      'delete': 'Del', 'tab': 'Tab', ',': ',', '/': '/', '.': '.',
      '-': '-', '=': '=', '[': '[', ']': ']', '\\': '\\', ';': ';', "'": "'",
    };
    const lower = keyName.toLowerCase();
    keyName = keyMap[lower] || keyName.toUpperCase();

    parts.push(keyName);
    return parts.join('+');
  }

  function labelFor(action) {
    const b = getBinding(action);
    return b ? formatKey(b) : '???';
  }

  // Short label for the bottom bar (^S style)
  function shortLabel(action) {
    const b = getBinding(action);
    if (!b) return '???';
    const keyMap = {
      'arrowup': '↑', 'arrowdown': '↓', 'arrowleft': '←', 'arrowright': '→',
      ',': ',', '/': '/', '.': '.', ' ': 'Spc'
    };
    const lower = b.key.toLowerCase();
    const keyStr = keyMap[lower] || b.key.toUpperCase();
    let prefix = '';
    if (b.ctrl) prefix += '^';
    if (b.shift) prefix += '⇧';
    if (b.alt) prefix += 'Alt+';
    return prefix + keyStr;
  }

  // ── Overlay UI ───────────────────────────────────────────────────────

  const overlay = document.getElementById('keybindings-overlay');
  const body = document.getElementById('keybindings-body');
  const closeBtn = document.getElementById('keybindings-close');
  const resetAllBtn = document.getElementById('keybindings-reset-all');

  if (!overlay || !body) return;

  function renderRows() {
    body.replaceChildren();
    bindings.forEach(b => {
      const row = document.createElement('div');
      row.className = 'keybindings-row';

      const label = document.createElement('span');
      label.className = 'keybindings-action';
      label.textContent = b.label;

      const keyBtn = document.createElement('button');
      keyBtn.className = 'keybindings-key-btn';
      keyBtn.textContent = formatKey(b);
      keyBtn.addEventListener('click', () => startListening(b.action, keyBtn));

      const resetBtn = document.createElement('button');
      resetBtn.className = 'keybindings-reset-btn';
      resetBtn.textContent = 'RESET';
      resetBtn.addEventListener('click', () => {
        const def = getDefault(b.action);
        if (def) {
          b.key = def.key;
          b.ctrl = def.ctrl;
          b.shift = def.shift;
          b.alt = def.alt;
          saveBindings();
          renderRows();
          updateEditorShortcutBar();
        }
      });

      row.appendChild(label);
      row.appendChild(keyBtn);
      row.appendChild(resetBtn);
      body.appendChild(row);
    });
  }

  function startListening(action, btnEl) {
    // Cancel any existing listener
    stopListening();

    listeningAction = action;
    btnEl.textContent = 'PRESS KEY...';
    btnEl.classList.add('listening');

    // Focus overlay so keydown fires
    overlay.focus();
  }

  function stopListening() {
    listeningAction = null;
    const listening = body.querySelector('.listening');
    if (listening) listening.classList.remove('listening');
  }

  function openOverlay() {
    renderRows();
    overlay.classList.remove('hidden');
    overlay.focus();
  }

  function closeOverlay() {
    stopListening();
    overlay.classList.add('hidden');
    // Return focus to editor textarea if it's open
    const editorOverlay = document.getElementById('editor-overlay');
    if (editorOverlay && !editorOverlay.classList.contains('hidden')) {
      const ta = document.getElementById('editor-textarea');
      if (ta) ta.focus();
    }
  }

  // ── Keyboard capture ─────────────────────────────────────────────────

  overlay.addEventListener('keydown', function(e) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      if (listeningAction) {
        stopListening();
        renderRows();
      } else {
        closeOverlay();
      }
      return;
    }

    if (!listeningAction) return;

    // Ignore bare modifier keys
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    const b = getBinding(listeningAction);
    if (!b) return;

    b.key = e.key;
    b.ctrl = e.ctrlKey || e.metaKey;
    b.shift = e.shiftKey;
    b.alt = e.altKey;

    saveBindings();
    stopListening();
    renderRows();
    updateEditorShortcutBar();
  });

  closeBtn.addEventListener('click', closeOverlay);

  resetAllBtn.addEventListener('click', function() {
    bindings = DEFAULTS.map(d => ({ ...d }));
    saveBindings();
    renderRows();
    updateEditorShortcutBar();
  });

  // ── Update editor bottom bar labels ──────────────────────────────────

  function updateEditorShortcutBar() {
    const bar = document.querySelector('.editor-shortcuts');
    if (!bar) return;

    const items = [
      { action: 'save',     label: 'SAVE' },
      { action: 'exit',     label: 'EXIT' },
      { action: 'saveExit', label: 'SAVE+EXIT' },
      { action: 'find',     label: 'FIND' },
      { action: 'dupLine',  label: 'DUP LINE' },
      { action: 'delLine',  label: 'DEL LINE' },
      { action: 'moveUp',   label: 'MOVE ↑' },
      { action: 'moveDown', label: 'MOVE ↓' },
      { action: 'comment',  label: 'COMMENT' },
      { action: 'goToLine', label: 'GO TO LN' },
      { action: 'keybindings', label: 'KEYS' },
    ];

    bar.replaceChildren(...items.map(item => {
      const keySpan = document.createElement('span');
      keySpan.className = 'editor-key';
      keySpan.textContent = shortLabel(item.action);

      const shortcutSpan = document.createElement('span');
      shortcutSpan.className = 'editor-shortcut';
      shortcutSpan.append(keySpan, ' ' + item.label);
      return shortcutSpan;
    }));
  }

  // ── Public API ───────────────────────────────────────────────────────

  Object.assign(FULCKeys, {
    open: openOverlay,
    close: closeOverlay,
    match: match,
    labelFor: labelFor,
    shortLabel: shortLabel,
    updateEditorShortcutBar: updateEditorShortcutBar,
  });
})();
