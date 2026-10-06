// ── Cursor Overlay (epic-7 task 12: live cursors + co-editing) ──────────────
//
// Surface-agnostic core module: shows colleagues' live cursors in shared
// apps. Rides the existing `core/presence.js` WebSocket channel (extended
// additively in D#204 with a `cursors` per-surface map) — this module never
// opens a socket of its own.
//
// Each surface (file-manager, kanban, ...) provides a `SurfaceAdapter` that
// knows how to turn a peer's opaque `cursor` payload into something drawable
// (an avatar row entry, a colored ring on a card, a Monaco decoration, ...).
// `CursorOverlay` owns the peer-subscription lifecycle and outbound-send
// throttling that every surface needs identically. "Fading after
// inactivity" is driven by the peer's own presence `status` (see
// `start()`'s doc comment) rather than a separate client-side timer.
//
// Per-surface, not a single slot (D#204 round-3 fix): a peer can legitimately
// be present in more than one surface at once (file-manager open in one
// window, the editor in another). `_onPeers` reads `peer.cursors[surfaceId]`
// — each adapter's own key in the server's per-peer map — never the legacy
// `peer.app`/`peer.cursor` scalar, which is last-writer-wins across every
// surface and was the root cause of a peer silently vanishing from one
// surface's presence row as soon as they opened a second one. See
// `crates/server/src/routes/presence.rs`'s "Per-surface storage" doc
// comment for the server-side half of this fix, and `PresencePeer.cursors`
// below. `start()` also arms a periodic, throttled republish so a surface's
// own state self-heals after a missed broadcast (`REPUBLISH_INTERVAL_MS`).
//
// The code editor (epic-13/04) already ships a fully working, independently
// proven remote-cursor pipeline over its own per-file collab WebSocket
// (`editor-collab.ts` / `crates/code-intel/src/crdt.rs`) — deliberately left
// as-is here rather than re-derived onto this shared module. See
// `epics/epic-7-cloud-infrastructure/12.md` Implementation Notes.
//
// Deterministic per-peer color is provided by the server (`PeerInfo.color`,
// a stable hash of the peer's email — see `crates/server/src/routes/
// presence.rs`), so this module doesn't need its own color assignment.
/** Outbound cursor-send throttle — keeps us well under the <200ms latency budget without flooding the socket on every mousemove/keystroke. */
const SEND_THROTTLE_MS = 120;
/**
 * Periodic self-heal republish interval. Most surfaces only publish their
 * cursor on their own state changes (a directory navigation, a card hover),
 * not on a timer — so a missed broadcast (a `Lagged` WS event, a brief
 * reconnect, a peer record evicted-then-recreated after a long disconnect)
 * can leave a surface's entry stale or absent with nothing to re-trigger a
 * send. Cheap and infrequent by design: this just re-sends whatever cursor
 * value is already pending, throttled the same as any other send, so it
 * costs one small WS frame per mounted surface every 20s — not a busy poll.
 */
const REPUBLISH_INTERVAL_MS = 20_000;
function prefersReducedMotion() {
    return (typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
/**
 * Drives one surface's remote-cursor rendering off the shared presence
 * channel. One instance per surface (not per peer).
 */
export class CursorOverlay {
    adapter;
    unsubscribe = null;
    activePeerIds = new Set();
    sendThrottleHandle = null;
    pendingCursor = null;
    reducedMotion;
    selfPeerId = null;
    republishHandle = null;
    constructor(adapter) {
        this.adapter = adapter;
        this.reducedMotion = prefersReducedMotion();
    }
    /** True if the viewer prefers reduced motion — adapters may skip transition/animation classes. */
    get prefersReducedMotion() {
        return this.reducedMotion;
    }
    /**
     * Subscribe to the presence channel. Call once, typically when the surface
     * app opens.
     *
     * "Fading after inactivity" (AC #4) is driven by the peer's own `status`
     * field, not an independent client-side timer: only `status === "online"`
     * peers are rendered. This reuses the server's existing, already-correct
     * heartbeat/away/offline machinery (`AWAY_AFTER` = 75s,
     * `crates/server/src/routes/presence.rs`) instead of inventing a second
     * clock. An earlier version here used its own `setInterval` staleness
     * sweep keyed off "time since the last broadcast this client happened to
     * receive" — that broke for any cursor state that doesn't itself
     * re-broadcast on a timer (e.g. "viewing this folder" is sent once, not
     * continuously like a mouse position), so an unchanged-but-still-valid
     * cursor silently vanished after the sweep window. Caught via CDP
     * verification: two live peers both showed in `FULCPresence.peers()`
     * throughout, but the avatar row emptied out ~8s after the one cursor
     * broadcast, before any inactivity had actually occurred.
     */
    start(presence) {
        if (this.unsubscribe)
            return; // already started
        this.selfPeerId = presence.peerId();
        this.unsubscribe = presence.onPeersChange((peers) => this._onPeers(peers));
        // Self-heal (see REPUBLISH_INTERVAL_MS doc comment): periodically
        // re-send whatever cursor value this surface currently has pending.
        // No-op while nothing has been sent yet (pendingCursor stays null until
        // the first `sendCursor` call).
        this.republishHandle = setInterval(() => {
            if (this.pendingCursor !== null) {
                presence.sendCursor(this.adapter.surfaceId, this.pendingCursor);
            }
        }, REPUBLISH_INTERVAL_MS);
    }
    /**
     * Report this client's own cursor state for the surface, throttled to
     * `SEND_THROTTLE_MS`. Pass `null` to clear (e.g. mouse left the surface).
     */
    sendCursor(presence, cursor) {
        this.pendingCursor = cursor;
        if (this.sendThrottleHandle !== null)
            return;
        this.sendThrottleHandle = setTimeout(() => {
            this.sendThrottleHandle = null;
            presence.sendCursor(this.adapter.surfaceId, this.pendingCursor);
        }, SEND_THROTTLE_MS);
    }
    /** Unsubscribe, clear all rendered peers, and cancel timers. */
    dispose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.sendThrottleHandle !== null) {
            clearTimeout(this.sendThrottleHandle);
            this.sendThrottleHandle = null;
        }
        if (this.republishHandle !== null) {
            clearInterval(this.republishHandle);
            this.republishHandle = null;
        }
        for (const peerId of this.activePeerIds)
            this.adapter.clear(peerId);
        this.activePeerIds.clear();
    }
    _onPeers(peers) {
        const seen = new Set();
        for (const peer of peers) {
            // Read this surface's own key from the per-surface map — NOT the
            // legacy `peer.app`/`peer.cursor` scalar, which is last-writer-wins
            // across every surface a peer has open (the D#204 round-3 defect: a
            // second surface publishing would silently evict this one). See
            // `PresencePeer.cursors`'s doc comment.
            const cursor = peer.cursors?.[this.adapter.surfaceId];
            if (cursor === null || cursor === undefined)
                continue;
            // Only "online" peers render — "away"/"offline" is this module's
            // inactivity signal (see `start()` doc comment).
            if (peer.status !== 'online')
                continue;
            const peerId = peer.peer_id ?? peer.email;
            if (peerId === this.selfPeerId)
                continue; // never render your own cursor to yourself
            const target = this.adapter.mapPeerStateToScreen(peer, cursor);
            if (!target)
                continue;
            seen.add(peerId);
            this.activePeerIds.add(peerId);
            this.adapter.render(target, peer);
        }
        for (const peerId of Array.from(this.activePeerIds)) {
            if (!seen.has(peerId)) {
                this.activePeerIds.delete(peerId);
                this.adapter.clear(peerId);
            }
        }
    }
}
// Expose the class on `window` for DevTools inspection / CDP verification —
// same pattern as `window.FULCCollabManager` in `editor-collab.ts`. The
// `Window.FULCCursorOverlay` shape is declared in `src-ts/types/fulc.d.ts`.
if (typeof window !== 'undefined') {
    window.FULCCursorOverlay = { CursorOverlay };
}
//# sourceMappingURL=cursor-overlay.js.map