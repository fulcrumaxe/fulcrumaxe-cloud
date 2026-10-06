// ── fulcrumaxe-os Presence ────────────────────────────────────────────────────────────
// Real-time presence: who is online / away / offline, plus (epic-7 task 12)
// an opaque per-surface cursor/awareness channel piggybacked on the same
// socket — no new socket per surface. `core/cursor-overlay.js` consumes the
// cursor channel via `onPeersChange`/`sendCursor`; it does not talk to the
// WebSocket directly.
//
// Renders avatar pills in the taskbar tray (right side) showing connected
// peers — cloud/skeleton mode only (unchanged from before task 12).
//
// Protocol:
//   1. Connect to WS /api/ws/presence?peer_id=<opaque, per-connection>
//   2. Server sends initial full snapshot as JsonPatch replacing /peers
//   3. Client sends {"type":"heartbeat"} every heartbeat_interval_secs
//   4. Client sends {"type":"cursor","app":"<surface-id>","cursor":<any>}
//      whenever a registered surface reports cursor movement (throttled by
//      the caller, e.g. `CursorOverlay`); {"cursor":null} clears THAT
//      surface's own entry only — the server stores cursor state per surface
//      (`peer.cursors[app]`, D#204 round-3), never a single shared slot, so
//      one surface publishing or clearing never affects another surface's
//      state for the same peer. Each incoming peer object also still carries
//      legacy top-level `app`/`cursor` fields (last-writer-wins across every
//      surface) for one release — `CursorOverlay` reads `peer.cursors[
//      surfaceId]`, not those.
//   5. Server sends incremental patches (whole-peer replace) on each change
//
// `peer_id` is a client-generated, sessionStorage-cached opaque id (same
// pattern as `editor-collab.js`'s collab peer id) — it lets two windows on
// the same session cookie (e.g. two local-mode browser windows, both
// resolved server-side to `local@jpos.dev`) show up as distinct peers.
// Older clients that never send `peer_id` fall back to one peer per email,
// exactly the pre-task-12 behavior.
//
// The WS connects in EVERY mode (local included) so surface cursor-sharing
// works without a cloud deployment — only the taskbar avatar strip stays
// gated to cloud/skeleton mode, unchanged from before.
//
// The avatar strip is inserted before #taskbar-tray's existing children.

// D#37 WS-B (fork edit, read flags only): gates init() on the cloud
// profile's `presence` feature flag so a deployment with presence:false
// opens no WebSocket and makes no request at all -- see the early-return in
// init() below.
import { getFeatures } from './features.js';

export const FULCPresence = {};

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────

  var peers = [];
  var ws = null;
  var heartbeatTimer = null;
  var heartbeatIntervalSecs = 30;
  var reconnectDelay = 2000;
  var reconnectTimer = null;
  var resyncPending = false;
  var avatarContainer = null;
  var currentEmail = null;
  var isCloudMode = false;
  var initialized = false;
  var peerListeners = [];

  // ── Peer id (epic-7 task 12) ────────────────────────────────────────────
  // Stable per-tab connection id — same pattern as editor-collab.js's
  // getOrCreatePeerId(). Not an identity claim; only disambiguates
  // concurrent connections sharing one resolved session identity.

  // D#37 WS-C2 criterion 12: computed lazily (on first real use, gated
  // the same way connectWs() already is by features.presence) rather
  // than eagerly at module-load time. This used to run unconditionally
  // for every profile, including cloud -- writing an unprefixed
  // `fulc-presence-peer-id` sessionStorage key on every boot even
  // though the cloud profile's presence feature is always off, which
  // made "sessionStorage.length === 0 after sign-out" unreachable no
  // matter what sign-out itself cleared.
  var _cachedPeerId = null;
  function getOrCreatePeerId() {
    if (_cachedPeerId) return _cachedPeerId;
    var key = 'fulc-presence-peer-id';
    var id = sessionStorage.getItem(key);
    if (!id) {
      id = 'peer-' + Math.random().toString(36).slice(2, 10)
             + Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem(key, id);
    }
    _cachedPeerId = id;
    return id;
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  function init() {
    if (initialized) return;
    initialized = true;

    // D#37 WS-B: cloud profile disables presence entirely
    // (features.presence === false) -- bail out before detectMode()/
    // resolveCurrentEmail()/connectWs() so this module opens no socket and
    // makes no request. getFeatures() resolves from core/features.js's
    // shared cache, not a second /api/mode probe.
    getFeatures().then(function (features) {
      if (features && features.presence === false) return;

      detectMode(function (mode) {
        isCloudMode = mode === 'cloud' || mode === 'skeleton';

        resolveCurrentEmail(function (email) {
          currentEmail = email; // may be null outside cloud mode; that's fine

          // Avatar strip stays cloud/skeleton-only (unchanged cosmetic gate).
          if (isCloudMode) createAvatarContainer();

          // The WS itself connects regardless of mode: surface cursor-sharing
          // (file-manager/kanban/editor presence) must work in local dev too,
          // where the server already falls back to `local@jpos.dev`.
          connectWs();
        });
      });
    });
  }

  function detectMode(cb) {
    fetch('/api/mode')
      .then(function (r) { return r.json(); })
      .then(function (d) { cb(d.mode); })
      .catch(function () { cb(null); });
  }

  function resolveCurrentEmail(cb) {
    fetch('/api/cloud/auth/me', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cb(d && d.email ? d.email : null); })
      .catch(function () { cb(null); });
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  function createAvatarContainer() {
    var tray = document.getElementById('taskbar-tray');
    if (!tray) return;

    // Remove stale container if any.
    var existing = document.getElementById('presence-avatars');
    if (existing) existing.remove();

    avatarContainer = document.createElement('span');
    avatarContainer.id = 'presence-avatars';
    avatarContainer.className = 'presence-avatar-strip';
    // Insert before the clock / user span.
    tray.insertBefore(avatarContainer, tray.firstChild);
  }

  function render() {
    if (!avatarContainer) return;

    // Show only online/away peers that are not the current user.
    var visible = peers.filter(function (p) {
      return p.email !== currentEmail &&
        (p.status === 'online' || p.status === 'away');
    });

    // Build avatar elements.
    var children = [];
    visible.forEach(function (p) {
      var initials = getInitials(p.display_name);
      var title = p.display_name + ' (' + p.status + ')';

      var initialsSpan = document.createElement('span');
      initialsSpan.className = 'presence-initials';
      // Untrusted value (peer display name) reaches the DOM only through
      // textContent -- never through markup concatenation.
      initialsSpan.textContent = initials;

      var dotSpan = document.createElement('span');
      dotSpan.className = 'presence-dot presence-dot--' + p.status;

      var avatarSpan = document.createElement('span');
      avatarSpan.className = 'presence-avatar';
      avatarSpan.title = title;
      avatarSpan.style.background = p.color;
      avatarSpan.append(initialsSpan, dotSpan);

      children.push(avatarSpan);
    });

    // Show self status indicator.
    var self = peers.find(function (p) { return p.email === currentEmail; });
    if (self) {
      var selfDot = document.createElement('span');
      selfDot.className = 'presence-self-dot presence-self-dot--' + self.status;
      selfDot.title = 'You (' + self.status + ')';
      children.unshift(selfDot);
    }

    avatarContainer.replaceChildren.apply(avatarContainer, children);
  }

  function getInitials(displayName) {
    var parts = (displayName || '?').trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  function connectWs() {
    if (ws) {
      ws.close();
      ws = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Auth is session-cookie based (C1 fix) — no email query param. `peer_id`
    // (epic-7 task 12) is NOT an identity claim, only a connection-slot
    // disambiguator within whatever identity the session resolves to.
    //
    // D#204 fix: the route lives at /api/ws/presence, not /ws/presence — the
    // server's presence::router() is merged into merge_api_routes, which
    // nests the whole thing under /api (see crates/server/src/routes/
    // presence.rs's router() doc comment). The old /ws/presence URL 404'd
    // in the real binary; verified via curl before/after this fix.
    var url = proto + '//' + location.host + '/api/ws/presence' +
      '?peer_id=' + encodeURIComponent(getOrCreatePeerId());

    ws = new WebSocket(url);

    ws.onopen = function () {
      reconnectDelay = 2000; // reset backoff
      startHeartbeat();
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.JsonPatch) {
          applyPatch(msg.JsonPatch);
        }
      } catch (e) {
        // ignore malformed
      }
    };

    ws.onclose = function () {
      stopHeartbeat();
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose fires after onerror, reconnect handled there.
    };
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, heartbeatIntervalSecs * 1000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWs();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  // D#307: recover from a local peer list we know to be stale. There is no
  // "send me a snapshot" client message in the protocol, so the resync uses
  // the machinery that already exists: drop the socket and let the normal
  // reconnect path re-run — the server's initial send on a new connection is
  // a full `/peers` replace. One resync at a time; cleared when that snapshot
  // lands (see applyPatch's `/peers` arm).
  function requestResync(reason) {
    if (resyncPending) return;
    resyncPending = true;
    console.warn('[presence] local peer list is stale (' + reason + ') — resyncing');
    if (ws) {
      try { ws.close(); } catch (e) { /* already closing; onclose still reconnects */ }
    } else {
      scheduleReconnect();
    }
  }

  // ── JSON Patch applier ───────────────────────────────────────────────────

  function applyPatch(ops) {
    ops.forEach(function (op) {
      if (op.path === '/peers' && op.op === 'replace') {
        // Full snapshot replacement.
        peers = Array.isArray(op.value) ? op.value : [];
        resyncPending = false; // the snapshot any pending resync was waiting for
        // N1 fix: op.value is always an array here (guarded above), so
        // checking op.value.heartbeat_interval_secs was always undefined.
        return;
      }

      // Whole-peer add/remove/replace: /peers/N or /peers/- (append)
      var whole = op.path.match(/^\/peers\/(-|\d+)$/);
      if (whole) {
        var key = whole[1];
        if (op.op === 'add') {
          if (key === '-') {
            peers.push(op.value);
          } else {
            peers.splice(parseInt(key, 10), 0, op.value);
          }
        } else if (op.op === 'remove') {
          if (key !== '-') {
            peers.splice(parseInt(key, 10), 1);
          }
        } else if (op.op === 'replace' && key !== '-') {
          var ri = parseInt(key, 10);
          if (peers[ri] !== undefined) {
            peers[ri] = op.value;
          } else {
            // D#307: the patch targets an index this client has never held —
            // its local array is shorter than the server's view of it (a peer
            // that first appeared after we connected, talking to a server
            // without the first-appearance fix). Assigning `peers[ri] =
            // op.value` here would fabricate `undefined` holes at every index
            // in between, which render() and every onPeersChange consumer
            // would then have to survive — a worse bug than the dropped
            // update. Recovery: treat the local array as stale and ask for a
            // fresh full snapshot, leaving the current array untouched (never
            // holed) until it arrives.
            requestResync('out-of-range replace at ' + op.path);
          }
        }
        return;
      }

      // Indexed field update: /peers/N/status
      var m = op.path.match(/^\/peers\/(\d+)\/(.+)$/);
      if (m) {
        var idx = parseInt(m[1], 10);
        var field = m[2];
        if (peers[idx]) {
          peers[idx][field] = op.value;
        }
      }
    });
    render();
    notifyPeerListeners();
  }

  // ── Cursor / awareness channel (epic-7 task 12) ──────────────────────────
  // Consumed by `core/cursor-overlay.js`'s `CursorOverlay`, not called
  // directly by app code. No new socket — piggybacks on the presence WS.

  function notifyPeerListeners() {
    if (!peerListeners.length) return;
    var snapshot = peers.slice();
    for (var i = 0; i < peerListeners.length; i++) {
      try { peerListeners[i](snapshot); } catch (e) { console.error('[presence] onPeersChange listener threw:', e); }
    }
  }

  function onPeersChange(cb) {
    peerListeners.push(cb);
    return function unsubscribe() {
      var idx = peerListeners.indexOf(cb);
      if (idx >= 0) peerListeners.splice(idx, 1);
    };
  }

  function sendCursor(app, cursor) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'cursor', app: app, cursor: cursor === undefined ? null : cursor }));
  }

  // ── Public API ───────────────────────────────────────────────────────────

  FULCPresence.init = init;
  FULCPresence.peers = function () { return peers.slice(); };
  // Genuinely "is the presence channel connected right now" — NOT gated on
  // cloud mode. Before epic-7 task 12 the WS itself only ever opened in
  // cloud/skeleton mode, so `isCloudMode && ws !== null` and "is active"
  // were the same thing. That's no longer true: the WS now connects in
  // every mode (local dev included, see module header) so surface cursor
  // sharing works without a cloud deployment — only the taskbar avatar
  // strip stays cloud-gated. Nothing in the tree currently calls
  // `isActive()` (verified via grep during the D#204 review round), so
  // fixing the semantics here is safe. Reflects the actual OPEN readyState,
  // not merely "not null", so a socket mid-reconnect correctly reports false.
  FULCPresence.isActive = function () { return ws !== null && ws.readyState === WebSocket.OPEN; };
  FULCPresence.peerId = function () { return getOrCreatePeerId(); };
  FULCPresence.onPeersChange = onPeersChange;
  FULCPresence.sendCursor = sendCursor;

  // Auto-init when DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Also exposed on `window` (in addition to the ESM export above) so TS
// surface adapters can read it without a static import — the same pattern
// used for `FULCUtil` (see `fulc.d.ts`), which keeps files with a matching
// `*.test.ts` resolvable under vitest (no `src-ts/core/presence.ts` source
// exists for this hand-written core module to type-resolve against).
window.FULCPresence = FULCPresence;
