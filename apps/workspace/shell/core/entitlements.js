// ── fulcrumaxe-os Entitlements ─────────────────────────────────────────────────────────
// Frontend mirror of the server-side resolver.
// Fetches a batch decision map at init, then subscribes via WebSocket for
// live patch updates. All gating helpers (FULCFeatureGate, FULCUpgradeModal)
// read from this module.
//
// D#37 WS-B (fork edit, read flags only): with features.liveEntitlements
// === false, _doInit() skips _openWebSocket() and instead refetches
// REST_URL on window focus -- see _initFocusRefetch()/_refetch() below.
import { getFeatures } from './features.js';

(function () {
  'use strict';

  const REST_URL = '/api/entitlements/me';
  const WS_PATH  = '/api/ws/entitlements';

  window.FULCEntitlements = {
    _decisions:    new Map(),
    _listeners:    [],
    _ready:        false,
    _initPromise:  null,
    // D#37 WS-C2 bugfix: the real apps/web /api/entitlements/me
    // (WS-C1 criterion 4) answers `{"entitlements":{},"default":"allow"}`,
    // not `{"decisions": {...}}` -- this module used to read only
    // `data.decisions` (always undefined against the real route) and
    // fall back to a hardcoded Deny for every unlisted capability,
    // which locked every app (including Themes) behind the upgrade
    // modal on every real sign-in. Reads BOTH `entitlements` (the real
    // field) and `decisions` (kept for any caller still on the older
    // shape) and honours `default` for anything neither one lists.
    // null until a fetch succeeds at least once, so a fetch failure
    // still gets the original safe-default (Deny) below.
    _defaultType: null,

    // ── Public API ─────────────────────────────────────────────────────

    async init() {
      if (this._initPromise) return this._initPromise;
      this._initPromise = this._doInit();
      return this._initPromise;
    },

    // Synchronous — returns false until init completes or if cap is unknown (safe default: deny).
    can(cap) {
      if (!this._ready) return false;
      return this.decision(cap).type === 'Allow';
    },

    decision(cap) {
      const known = this._decisions.get(cap);
      if (known) return known;
      if (this._defaultType) return { type: this._defaultType, reason: 'default' };
      return { type: 'Deny', reason: 'unknown' };
    },

    onChange(cb) {
      this._listeners.push(cb);
      // Return a handle so callers can unsubscribe.
      return { unsubscribe: () => {
        const i = this._listeners.indexOf(cb);
        if (i !== -1) this._listeners.splice(i, 1);
      }};
    },

    // ── App-gating helpers (shared by desktop.js and heritage docks) ───

    // Returns the capability string for an app definition object or bare id string.
    appCapability(def) {
      if (!def) return 'app.unknown';
      if (typeof def === 'string') return 'app.' + def;
      return def.capability || ('app.' + (def.id || 'unknown'));
    },

    // Returns 'show-locked' | 'hide' (default: 'show-locked').
    appWhenDenied(def) {
      if (!def || typeof def === 'string') return 'show-locked';
      return def.whenDenied || 'show-locked';
    },

    // Returns the entitlement decision. Returns {type:'Allow'} until _ready.
    appDecision(def) {
      if (!this._ready) return { type: 'Allow' };
      return this.decision(this.appCapability(def));
    },

    // Returns true when the app should be omitted entirely (Deny + hide).
    isAppHidden(def) {
      const d = this.appDecision(def);
      return d.type === 'Deny' && this.appWhenDenied(def) === 'hide';
    },

    // Applies lock overlay class + FULCFeatureGate overlay if denied.
    // Returns the decision. Safe no-op when allowed.
    applyGate(el, def) {
      const d = this.appDecision(def);
      if (d.type !== 'Allow') {
        el.classList.add('fulc-entitlement-locked');
        if (window.FULCFeatureGate) {
          window.FULCFeatureGate._applyOverlay(el, this.appCapability(def), d);
        }
      }
      return d;
    },

    // ── Internal ───────────────────────────────────────────────────────

    async _doInit() {
      try {
        const res = await fetch(REST_URL);
        if (res.ok) {
          const data = await res.json();
          this._applyDefault(data.default);
          this._applyDecisions(data.entitlements || data.decisions || {});
        }
      } catch (e) {
        console.warn('[entitlements] init fetch failed:', e);
      }
      this._ready = true;

      // D#37 WS-B: cloud profile disables the live entitlements socket --
      // refetch on window focus instead of holding a connection open.
      const features = await getFeatures();
      if (features && features.liveEntitlements === false) {
        this._initFocusRefetch();
        return;
      }
      this._openWebSocket();
    },

    _focusRefetchBound: false,

    _initFocusRefetch() {
      if (this._focusRefetchBound) return;
      this._focusRefetchBound = true;
      window.addEventListener('focus', () => { this._refetch(); });
    },

    async _refetch() {
      try {
        const res = await fetch(REST_URL);
        if (res.ok) {
          const data = await res.json();
          this._applyDefault(data.default);
          this._applyDecisions(data.entitlements || data.decisions || {});
        }
      } catch (e) {
        console.warn('[entitlements] focus refetch failed:', e);
      }
    },

    _applyDefault(defaultValue) {
      if (defaultValue === 'allow') this._defaultType = 'Allow';
      else if (defaultValue === 'deny') this._defaultType = 'Deny';
    },

    _applyDecisions(decisions) {
      let changed = false;
      for (const [cap, decision] of Object.entries(decisions)) {
        this._decisions.set(cap, decision);
        changed = true;
      }
      if (changed) this._notify();
    },

    _applyPatch(patches) {
      let changed = false;
      for (const patch of patches) {
        const key = patch.path.replace(/^\//, '');
        if (patch.op === 'add' || patch.op === 'replace') {
          this._decisions.set(key, patch.value);
          changed = true;
        } else if (patch.op === 'remove') {
          this._decisions.delete(key);
          changed = true;
        }
      }
      if (changed) this._notify();
    },

    _notify() {
      for (const cb of this._listeners) {
        try { cb(this._decisions); } catch (e) {
          console.error('[entitlements] onChange callback threw:', e);
        }
      }
    },

    _wsConnected: false,
    _wsBackoffMs: 1000,

    _openWebSocket() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}${WS_PATH}`;
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => {
          this._wsConnected = true;
          this._wsBackoffMs = 1000;
          console.info('[entitlements] WS connected');
        };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'EntitlementPatch' && Array.isArray(msg.patches)) {
              this._applyPatch(msg.patches);
            }
          } catch (e) {
            console.warn('[entitlements] WS parse error:', e);
          }
        };
        ws.onerror = (ev) => {
          console.warn('[entitlements] WS error:', ev);
        };
        ws.onclose = () => {
          const wasConnected = this._wsConnected;
          this._wsConnected = false;
          if (!this._ready) return;
          // Exponential backoff capped at 60 s. Reset on every successful open.
          const delay = wasConnected ? 1000 : Math.min(this._wsBackoffMs, 60000);
          this._wsBackoffMs = Math.min(this._wsBackoffMs * 2, 60000);
          setTimeout(() => this._openWebSocket(), delay);
        };
      } catch (e) {
        console.warn('[entitlements] WebSocket unavailable:', e);
      }
    },
  };
})();

export {};
