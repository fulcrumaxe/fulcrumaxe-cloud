// ── fulcrumaxe-os Command Registry ────────────────────────────────────────────
// Core command infrastructure: tokenizer, registry, execution, output helpers,
// tab completion, input binding, alias management.
// Exports: FULCCommands { init, register, print, printHTML, clear, apiFetch }
//
// D#37 WS-C2 criterion 12: also owns the "signout" command and the
// Ctrl/Cmd+K command palette that makes it reachable independent of the
// terminal app's own command-input/command-output DOM (which this
// cloud profile doesn't ship).
import { signOut } from "./cloud-signout.js";
// D#37 WS-C2 fix round item 3 (W2, CWE-359): aliases persisted under
// storage-ns.js's fx:<ns>: namespace, not a raw localStorage key.
import { getItem, setItem, onNamespaceReady } from "./storage-ns.js";

export const FULCCommands = {};
(function () {
  'use strict';

  // ── Lazy DOM ─────────────────────────────────────────────────────────

  function getCmdInput() { return document.getElementById('command-input'); }
  function getCmdOutput() { return document.getElementById('command-output'); }

  // ── State ────────────────────────────────────────────────────────────

  const commandHistory = [];
  let historyIndex = -1;
  let historyStash = '';
  const aliases = loadAliases();
  onNamespaceReady(refreshAliases);
  const MAX_HISTORY = 200;
  let initialized = false;

  // ── Output helpers ───────────────────────────────────────────────────

  function cmdPrint(text, cls) {
    const out = getCmdOutput();
    if (!out) return;
    const p = document.createElement('p');
    if (cls) p.className = cls;
    p.textContent = text;
    out.appendChild(p);
    out.scrollTop = out.scrollHeight;
  }

  function cmdPrintHTML(html, cls) {
    const out = getCmdOutput();
    if (!out) return;
    const div = document.createElement('div');
    if (cls) div.className = cls;
    // D#37 WS-C2 fix round: the WS-C2b comment this replaces claimed
    // DOMParser.parseFromString() wasn't a Trusted Types sink because the
    // parsed document is inert -- that's wrong. parseFromString() IS a
    // require-trusted-types-for 'script' sink regardless of what happens to
    // its result, confirmed live via a CSP violation report. Nothing in
    // this repo calls printHTML, so rather than stand up a Trusted Types
    // policy to parse strings no caller passes, render the input as plain
    // text the same way cmdPrint() does. A future caller that actually
    // needs markup should build a DOM Node itself and pass that instead of
    // a string.
    div.textContent = html;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  function cmdClear() {
    const out = getCmdOutput();
    if (!out) return;
    while (out.firstChild) out.removeChild(out.firstChild);
  }

  // ── Tokenizer ────────────────────────────────────────────────────────

  function tokenize(input) {
    const tokens = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inQuote) {
        if (ch === quoteChar) inQuote = false;
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ' ') {
        if (current.length > 0) { tokens.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
  }

  // ── Command Registry ─────────────────────────────────────────────────

  const commands = {};

  // Category short flags for filtering
  const CATEGORY_FLAGS = {
    s: 'system', sys: 'system',
    m: 'messages', msg: 'messages',
    f: 'files', file: 'files',
    a: 'admin',
    p: 'preferences', pref: 'preferences',
    c: 'communication', comm: 'communication',
    e: 'editor',
    d: 'desktop',
    u: 'custom', user: 'custom'
  };

  function registerCommand(name, opts) {
    commands[name] = {
      usage: opts.usage || name,
      description: opts.description || '',
      adminOnly: opts.adminOnly || false,
      category: opts.category || 'system',
      run: opts.run
    };
  }

  function getAvailableCommands(categoryFilter) {
    return Object.keys(commands).filter(name => {
      if (commands[name].adminOnly && !window.currentIsAdmin) return false;
      if (categoryFilter && commands[name].category !== categoryFilter) return false;
      return true;
    });
  }

  function getCategories() {
    const cats = new Set();
    Object.values(commands).forEach(c => cats.add(c.category));
    return Array.from(cats).sort();
  }

  function resolveCategory(flag) {
    const f = flag.toLowerCase().replace(/^-+/, '');
    return CATEGORY_FLAGS[f] || f;
  }

  // ── Command Execution ────────────────────────────────────────────────

  async function executeRaw(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    cmdPrint('> ' + trimmed, 'cmd-echo');

    if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== trimmed) {
      commandHistory.push(trimmed);
      if (commandHistory.length > MAX_HISTORY) commandHistory.shift();
    }
    historyIndex = -1;
    historyStash = '';

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return;

    const firstWord = tokens[0].toLowerCase();
    if (aliases[firstWord]) {
      const aliasTokens = tokenize(aliases[firstWord]);
      tokens.splice(0, 1, ...aliasTokens);
    }

    const twoWord = tokens.length >= 2 ? tokens[0].toLowerCase() + ' ' + tokens[1].toLowerCase() : null;
    let cmd = null;
    let args = [];

    if (twoWord && commands[twoWord]) {
      cmd = commands[twoWord];
      args = tokens.slice(2);
    } else if (commands[tokens[0].toLowerCase()]) {
      cmd = commands[tokens[0].toLowerCase()];
      args = tokens.slice(1);
    }

    if (!cmd) {
      cmdPrint('ERROR: UNKNOWN COMMAND "' + tokens[0].toUpperCase() + '". TYPE "HELP" FOR ASSISTANCE.', 'cmd-error');
      return;
    }

    if (cmd.adminOnly && !window.currentIsAdmin) {
      cmdPrint('ERROR: ADMINISTRATIVE CLEARANCE REQUIRED.', 'cmd-error');
      return;
    }

    try {
      await cmd.run(args);
    } catch (e) {
      cmdPrint('ERROR: ' + (e.message || 'COMMAND EXECUTION FAILED'), 'cmd-error');
    }
  }

  // ── API helper ───────────────────────────────────────────────────────

  async function apiFetch(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'REQUEST FAILED');
    return data;
  }

  // ── Alias Persistence ────────────────────────────────────────────────

  function loadAliases() {
    try { return JSON.parse(getItem('fulc_aliases') || '{}'); }
    catch (e) { return {}; }
  }

  /** Re-reads persisted aliases once a namespace exists, mutating the exported `aliases` object in place (it's `const` and referenced by reference elsewhere -- see `FULCCommands.aliases` below). */
  function refreshAliases() {
    const fresh = loadAliases();
    for (const k of Object.keys(aliases)) delete aliases[k];
    Object.assign(aliases, fresh);
  }

  function saveAliases() {
    setItem('fulc_aliases', JSON.stringify(aliases));
  }

  // ── Tab Completion ───────────────────────────────────────────────────

  let tabMatches = [];
  let tabIndex = -1;
  let tabPrefix = '';

  async function getCompletions(inputText) {
    const tokens = tokenize(inputText);
    const partial = inputText.endsWith(' ') ? '' : (tokens.pop() || '');
    const prefix = tokens.join(' ');
    const completions = [];

    if (tokens.length === 0 || (tokens.length === 1 && !inputText.endsWith(' '))) {
      const available = getAvailableCommands();
      const seen = new Set();
      for (const name of available) {
        const firstWord = name.split(' ')[0];
        if (firstWord.startsWith(partial.toLowerCase()) && !seen.has(firstWord)) {
          seen.add(firstWord);
          completions.push(firstWord);
        }
      }
      for (const name of Object.keys(aliases)) {
        if (name.startsWith(partial.toLowerCase()) && !seen.has(name)) {
          completions.push(name);
        }
      }
    } else {
      const firstWord = tokens[0].toLowerCase();
      const available = getAvailableCommands();
      const twoWordCmds = available.filter(n => n.startsWith(firstWord + ' '));

      if (tokens.length === 1 && inputText.endsWith(' ')) {
        for (const name of twoWordCmds) {
          completions.push(name.split(' ')[1]);
        }
      } else if (tokens.length === 2 && !inputText.endsWith(' ')) {
        for (const name of twoWordCmds) {
          const secondWord = name.split(' ')[1];
          if (secondWord.startsWith(partial.toLowerCase())) completions.push(secondWord);
        }
      }

      const fullCmd = tokens.slice(0, 2).join(' ').toLowerCase();
      // D#37 WS-C2 criterion 9/12 cleanup: /api/admin/users is one of
      // WS-C1 criterion 6's must-404 paths in this fork -- this
      // completion never had a live endpoint to call in cloud mode.

      if (fullCmd === 'branding set') {
        for (const k of ['system_tag', 'os_name', 'copyright', 'welcome_message', 'page_title']) {
          if (k.startsWith(partial.toLowerCase())) completions.push(k);
        }
      }

      if (fullCmd === 'set theme') {
        for (const t of ['green', 'amber', 'blue', 'white', 'red']) {
          if (t.startsWith(partial.toLowerCase())) completions.push(t);
        }
      }
      if (fullCmd === 'set fontsize') {
        for (const s of ['small', 'medium', 'large']) {
          if (s.startsWith(partial.toLowerCase())) completions.push(s);
        }
      }
      if (fullCmd === 'set crt') {
        for (const v of ['on', 'off']) {
          if (v.startsWith(partial.toLowerCase())) completions.push(v);
        }
      }
      if (fullCmd === 'set avatar') {
        for (let i = 0; i < 8; i++) {
          if (String(i).startsWith(partial)) completions.push(String(i));
        }
      }
      if (fullCmd === 'set timezone') {
        const tzs = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney'];
        for (const tz of tzs) {
          if (tz.toLowerCase().startsWith(partial.toLowerCase())) completions.push(tz);
        }
      }

      // D#37 WS-C2 criterion 9/12 cleanup: /api/users and /api/files are
      // both must-404 in this fork (WS-C1 criterion 6) -- the "msg
      // send" and file-command completions above them never had a live
      // endpoint to call in cloud mode, so both are dropped rather than
      // left calling a path that never answers.

      // Export format completion
      if (firstWord.toLowerCase() === 'export' && tokens.length >= 2) {
        for (const fmt of ['txt', 'md', 'html', 'json', 'csv', 'js', 'py', 'rs', 'xml', 'log']) {
          if (fmt.startsWith(partial.toLowerCase())) completions.push(fmt);
        }
      }

      // Open command completion
      if (firstWord.toLowerCase() === 'open') {
        const appIds = window.FULCApps ? window.FULCApps.ids() : [];
        for (const id of appIds) {
          if (id.startsWith(partial.toLowerCase())) completions.push(id);
        }
      }
    }

    return { completions, partial, prefix };
  }

  async function handleTab(e) {
    e.preventDefault();
    const cmdInput = getCmdInput();
    if (!cmdInput) return;
    const inputText = cmdInput.value;

    if (tabIndex === -1) {
      const result = await getCompletions(inputText);
      tabMatches = result.completions;
      tabPrefix = result.prefix;

      if (tabMatches.length === 0) return;

      if (tabMatches.length === 1) {
        const completed = tabPrefix ? tabPrefix + ' ' + tabMatches[0] : tabMatches[0];
        cmdInput.value = completed + ' ';
        tabIndex = -1;
        tabMatches = [];
        return;
      }

      cmdPrint('');
      cmdPrint(tabMatches.join('  '), 'cmd-info');
      tabIndex = 0;
    } else {
      tabIndex = (tabIndex + 1) % tabMatches.length;
    }

    const completed = tabPrefix ? tabPrefix + ' ' + tabMatches[tabIndex] : tabMatches[tabIndex];
    cmdInput.value = completed;
  }

  // ── Input Binding ────────────────────────────────────────────────────

  function bindInputEvents() {
    const cmdInput = getCmdInput();
    if (!cmdInput) return;

    cmdInput.addEventListener('focus', () => { window.inputIsEditing = true; });
    cmdInput.addEventListener('blur', () => { window.inputIsEditing = false; });

    cmdInput.addEventListener('input', () => {
      tabIndex = -1;
      tabMatches = [];
    });

    cmdInput.addEventListener('keydown', async (e) => {
      // Stop events from reaching global handlers (desktop nav, etc.)
      e.stopPropagation();
      if (window.overlayFocused) return;

      if (e.key === 'Tab') { await handleTab(e); return; }
      if (e.key !== 'Shift') { tabIndex = -1; tabMatches = []; }

      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = cmdInput.value;
        cmdInput.value = '';
        await executeRaw(raw);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandHistory.length === 0) return;
        if (historyIndex === -1) {
          historyStash = cmdInput.value;
          historyIndex = commandHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        cmdInput.value = commandHistory[historyIndex];
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex === -1) return;
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          cmdInput.value = commandHistory[historyIndex];
        } else {
          historyIndex = -1;
          cmdInput.value = historyStash;
        }
        return;
      }

      if (e.key === 'Escape') {
        cmdInput.value = '';
        cmdInput.blur();
        return;
      }
    });
  }

  // ── Welcome message on terminal open ─────────────────────────────────

  async function showWelcome() {
    cmdPrint('COMMAND TERMINAL READY. TYPE "HELP" FOR COMMANDS.', 'cmd-info');

    try {
      if (window.E2ECrypto && window.profileData && window.profileData.username) {
        await window.E2ECrypto.initializeEncryption(window.profileData.username);
        cmdPrint('E2E ENCRYPTION INITIALIZED. RSA-2048 + AES-256-GCM ACTIVE.', 'cmd-success');
      } else if (window.E2ECrypto) {
        // Profile not loaded yet — retry after a moment
        setTimeout(async () => {
          try {
            if (window.profileData && window.profileData.username) {
              await window.E2ECrypto.initializeEncryption(window.profileData.username);
            }
          } catch (e) {}
        }, 2000);
        cmdPrint('E2E ENCRYPTION: INITIALIZING...', 'cmd-info');
      }
    } catch (e) {
      // Crypto API may not be available (requires HTTPS or localhost)
      if (window.isSecureContext === false) {
        cmdPrint('NOTE: E2E ENCRYPTION REQUIRES HTTPS. MESSAGING USES SERVER-SIDE ENCRYPTION.', 'cmd-info');
      } else {
        cmdPrint('WARNING: ENCRYPTION INIT FAILED. MESSAGING MAY BE UNAVAILABLE.', 'cmd-error');
      }
    }

    // D#37 WS-C2 criterion 9/12 cleanup: /api/motd and /api/announcements
    // are both must-404 in this fork (WS-C1 criterion 6) -- dropped
    // rather than left calling a path that never answers.

    try {
      const unread = await apiFetch('/api/messages/unread');
      if (unread.count > 0) {
        cmdPrint('');
        cmdPrint('YOU HAVE ' + unread.count + ' UNREAD MESSAGE(S). TYPE "MSG INBOX" TO VIEW.', 'cmd-success');
      }
    } catch (e) {}
  }

  // ── Init ─────────────────────────────────────────────────────────────

  let boundInput = null; // track which input element has listeners

  function init() {
    const input = getCmdInput();
    const output = getCmdOutput();
    if (!input || !output) return;

    // Re-bind if the DOM element changed (e.g., shell hotswap)
    if (input === boundInput) return;
    boundInput = input;

    bindInputEvents();

    if (initialized) return; // only show welcome once
    initialized = true;
    setTimeout(async () => {
      // Load custom commands from DB via dynamic import — avoids a static
      // cycle with command-builder-app.js, which imports from us.
      try {
        const mod = await import('../apps/command-builder/command-builder-app.js');
        if (mod.FULCCustomCommands) await mod.FULCCustomCommands.load();
      } catch (e) { /* command-builder not loaded; non-fatal */ }
      showWelcome();
    }, 300);
  }

  // ── Sign out ─────────────────────────────────────────────────────────
  // D#37 WS-C2 criterion 12: reachable from the command palette below
  // and from core/taskbar.js's dock/user menu.

  registerCommand('signout', {
    usage: 'signout',
    description: 'Sign out of fulcrumaxe workspace',
    category: 'system',
    run: async () => { await signOut(); },
  });

  // ── Command Palette ──────────────────────────────────────────────────
  // A global Ctrl/Cmd+K palette, independent of the terminal's own
  // command-input/command-output DOM (this cloud profile ships no
  // terminal app, so init() below never binds to it) -- lists every
  // registered command and runs the one the user picks or types.
  // Only active once signed in (window.currentStep === 'DESKTOP'): D#37
  // WS-C2 criterion 10 requires zero <input> elements anywhere before
  // that, and this overlay renders one.

  let paletteOpen = false;

  function closePalette() {
    if (!paletteOpen) return;
    paletteOpen = false;
    const el = document.getElementById('command-palette');
    if (el) el.remove();
    document.removeEventListener('keydown', onPaletteKeydown, true);
  }

  function renderPaletteResults(listEl, filter) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    const f = filter.toLowerCase();
    const names = getAvailableCommands().filter((name) => name.includes(f));
    names.slice(0, 20).forEach((name) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.className = 'command-palette-item';
      item.textContent = commands[name].description ? name + ' — ' + commands[name].description : name;
      item.style.cssText =
        'display:block;width:100%;text-align:left;padding:8px 12px;background:none;' +
        'border:none;color:inherit;font:inherit;cursor:pointer;';
      item.addEventListener('click', () => {
        closePalette();
        executeRaw(name);
      });
      listEl.appendChild(item);
    });
  }

  function openPalette() {
    if (paletteOpen) return;
    paletteOpen = true;
    const overlay = document.createElement('div');
    overlay.id = 'command-palette';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Command palette');
    overlay.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:flex-start;justify-content:center;' +
      'padding-top:15vh;background:rgba(0,0,0,0.5);z-index:9600;';
    const dialog = document.createElement('div');
    dialog.style.cssText =
      'width:min(480px,90vw);background:#000;border:1px solid currentColor;color:inherit;font-family:monospace;';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'command-palette-input';
    input.placeholder = 'Type a command…';
    input.setAttribute('aria-label', 'Command palette');
    input.style.cssText =
      'width:100%;box-sizing:border-box;padding:10px 12px;background:#000;border:none;' +
      'border-bottom:1px solid currentColor;color:inherit;font:inherit;';
    dialog.appendChild(input);
    const list = document.createElement('div');
    list.id = 'command-palette-list';
    dialog.appendChild(list);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
    renderPaletteResults(list, '');
    input.addEventListener('input', () => renderPaletteResults(list, input.value));
    document.addEventListener('keydown', onPaletteKeydown, true);
    setTimeout(() => input.focus(), 0);
  }

  function onPaletteKeydown(e) {
    if (e.key === 'Escape') closePalette();
  }

  document.addEventListener('keydown', (e) => {
    if (window.currentStep !== 'DESKTOP') return;
    const isMeta = e.ctrlKey || e.metaKey;
    if (!isMeta || e.key.toLowerCase() !== 'k') return;
    e.preventDefault();
    if (paletteOpen) closePalette();
    else openPalette();
  });

  // ── Public API ───────────────────────────────────────────────────────

  Object.assign(FULCCommands, {
    init: init,
    register: registerCommand,
    execute: executeRaw,
    print: cmdPrint,
    printHTML: cmdPrintHTML,
    clear: cmdClear,
    apiFetch: apiFetch,
    getCommands: () => commands,
    getAvailable: getAvailableCommands,
    getCategories: getCategories,
    resolveCategory: resolveCategory,
    aliases: aliases,
    saveAliases: saveAliases
  });
  // Exposes FULCCommands on window, same as core/window-manager.js does
  // for FULCWM -- nothing in this cloud profile currently wires
  // aliases/saveAliases to a UI (no settings panel ships `alias` command
  // in apps/agents, apps/kanban or apps/themes, the only app_modules
  // this profile loads), so window.FULCCommands is this module's only
  // reachable entry point for e2e coverage of the fx:<ns>: alias
  // persistence path (D#37 WS-C2 fix round item 3, W2).
  window.FULCCommands = FULCCommands;
})();
