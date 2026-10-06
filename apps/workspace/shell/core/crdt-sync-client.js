// ── CRDT Sync Client ────────────────────────────────────────────────────────
// Manages WebSocket connections to /api/ws/crdt/sync for automerge document sync.
//
// When @automerge/automerge WASM is ready (AutomergeWasm.ready === true) this
// client performs real binary automerge sync handshakes. When WASM is absent
// it falls back to the REST peer-count poll path so the Shared badge still
// renders peer counts.
//
// Public API (preserved from D#116 / PR #118):
//   CrdtSyncClient.connect(docId, listener)
//   CrdtSyncClient.disconnect(docId)
//   CrdtSyncClient.peerCount(docId)
//   CrdtSyncClient.addListener(docId, listener)
//   CrdtSyncClient.removeListener(docId, listener)
//   CrdtSyncClient.getDoc(docId)         → Automerge.Doc or null
//   CrdtSyncClient.change(docId, fn)     → apply a local mutation and sync
//
// Events fired to listeners:
//   'connected'    { doc_id }
//   'disconnected' { doc_id }
//   'peers'        { doc_id, peer_count }
//   'change'       { doc_id, doc, changes, isLocal }   (WASM mode only)
//                  isLocal: true = originated from this tab's change() call
//                  isLocal: false = received from a remote peer via WS
//
// Auth: cookie-based. Cloud-mode only — no-ops in local mode.

// Reduced poll interval when WS+WASM are active (backup / peer-discovery only)
const PEER_POLL_INTERVAL_WS   = 30000; // ms — when WASM sync is active
const PEER_POLL_INTERVAL_REST = 8000;  // ms — REST-only fallback

// Reconnect backoff (mirrors presence.js's scheduleReconnect pattern).
const RECONNECT_DELAY_INITIAL = 2000;  // ms
const RECONNECT_DELAY_MAX     = 30000; // ms

// Map of doc_id → { ws, peerCount, listeners, pollTimer, doc, syncState,
//                    reconnectTimer, reconnectDelay, explicitDisconnect }
const connections = {};

function freshConnState() {
    return {
        ws: null,
        peerCount: 0,
        listeners: [],
        pollTimer: null,
        doc: null,
        syncState: null,
        wasmActive: false,
        reconnectTimer: null,
        reconnectDelay: RECONNECT_DELAY_INITIAL,
        explicitDisconnect: false,
    };
}

let _cloudMode = null;
async function isCloudMode() {
    if (_cloudMode !== null) return _cloudMode;
    try {
        const r = await fetch('/api/mode').then(res => res.ok ? res.json() : null);
        _cloudMode = !!(r && (r.mode === 'cloud' || r.mode === 'skeleton'));
    } catch (_) {
        _cloudMode = false;
    }
    return _cloudMode;
}

function wsUrl(docId) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${proto}//${host}/api/ws/crdt/sync?doc_id=${encodeURIComponent(docId)}`;
}

async function fetchPeerCount(docId) {
    try {
        const url = `/api/crdt/sync/peers?doc_id=${encodeURIComponent(docId)}`;
        const r = await fetch(url);
        if (!r.ok) return 0;
        const data = await r.json();
        return typeof data.peer_count === 'number' ? data.peer_count : 0;
    } catch (_) {
        return 0;
    }
}

function notifyListeners(docId, event, payload) {
    const conn = connections[docId];
    if (!conn) return;
    for (const listener of [...conn.listeners]) {
        try { listener(event, payload); }
        catch (e) { console.warn('[crdt-sync] listener error:', e); }
    }
}

function peerPollInterval(docId) {
    const conn = connections[docId];
    return (conn && conn.wasmActive) ? PEER_POLL_INTERVAL_WS : PEER_POLL_INTERVAL_REST;
}

async function startPeerPoll(docId) {
    const conn = connections[docId];
    if (!conn || conn.pollTimer) return;

    async function tick() {
        const count = await fetchPeerCount(docId);
        const c = connections[docId];
        if (!c) return;
        if (c.peerCount !== count) {
            c.peerCount = count;
            notifyListeners(docId, 'peers', { doc_id: docId, peer_count: count });
        }
        // Re-schedule with current interval (may have changed if WASM became ready)
        if (c.pollTimer) {
            clearInterval(c.pollTimer);
            c.pollTimer = setInterval(tick, peerPollInterval(docId));
        }
    }

    await tick();
    conn.pollTimer = setInterval(tick, peerPollInterval(docId));
}

function stopPeerPoll(docId) {
    const conn = connections[docId];
    if (!conn || !conn.pollTimer) return;
    clearInterval(conn.pollTimer);
    conn.pollTimer = null;
}

// ── Automerge sync helpers ───────────────────────────────────────────────────

function getAutomerge() {
    return window.AutomergeWasm && window.AutomergeWasm.ready
        ? window.AutomergeWasm.Automerge
        : null;
}

/**
 * Initialise (or reinitialise) the automerge doc + sync state for a connection.
 * Called once WASM is confirmed ready and the WS is open.
 */
function initAutomergeState(docId) {
    const A = getAutomerge();
    if (!A) return;
    const conn = connections[docId];
    if (!conn) return;

    // Use stable API: init() creates an empty doc, initSyncState() creates a
    // fresh sync state. The server will send its full state on first exchange.
    if (!conn.doc) {
        conn.doc = A.init();
    }
    if (!conn.syncState) {
        conn.syncState = A.initSyncState();
    }
    conn.wasmActive = true;
}

/**
 * Generate and send the next sync message to the server.
 * Must be called after every receiveSyncMessage to drive the exchange.
 */
function sendSyncMessage(docId) {
    const A = getAutomerge();
    const conn = connections[docId];
    if (!A || !conn || !conn.doc || !conn.syncState) return;
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;

    const [nextSyncState, message] = A.generateSyncMessage(conn.doc, conn.syncState);
    conn.syncState = nextSyncState;

    if (message) {
        conn.ws.send(message);
    }
}

/**
 * Process an incoming binary sync message from the server.
 */
function handleSyncMessage(docId, data) {
    const A = getAutomerge();
    const conn = connections[docId];
    if (!A || !conn || !conn.doc || !conn.syncState) return;

    try {
        const bytes = new Uint8Array(data);
        const [nextDoc, nextSyncState, patches] = A.receiveSyncMessage(
            conn.doc,
            conn.syncState,
            bytes
        );

        const hadChanges = patches && patches.length > 0;
        conn.doc = nextDoc;
        conn.syncState = nextSyncState;

        if (hadChanges) {
            notifyListeners(docId, 'change', {
                doc_id: docId,
                doc: conn.doc,
                changes: patches,
                isLocal: false,
            });
        }

        // Continue the sync exchange
        sendSyncMessage(docId);
    } catch (e) {
        console.warn('[crdt-sync] error processing sync message for', docId, e);
    }
}

// ── Reconnect ────────────────────────────────────────────────────────────────

function clearReconnect(conn) {
    if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
    }
}

function scheduleReconnect(docId) {
    const conn = connections[docId];
    if (!conn || conn.explicitDisconnect) return;
    // Already scheduled or already connecting/open — don't stack a second attempt
    // (this is the double-connect guard: close can fire while a fresh open() is
    // already in flight from a previous scheduleReconnect tick).
    if (conn.reconnectTimer) return;
    if (conn.ws && conn.ws.readyState <= 1 /* CONNECTING | OPEN */) return;

    conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        const c = connections[docId];
        if (!c || c.explicitDisconnect) return;
        openSocket(docId);
    }, conn.reconnectDelay);
    conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_DELAY_MAX);
}

/**
 * Open (or re-open) the WebSocket for docId. Used both for the initial
 * connect() and for reconnect-after-close. Idempotent against concurrent
 * open attempts via the CONNECTING/OPEN readyState guard in callers.
 */
function openSocket(docId) {
    const conn = connections[docId];
    if (!conn) return;

    // Guard against double-connect: a reconnect tick and an explicit connect()
    // call could otherwise both reach here for the same doc.
    if (conn.ws && conn.ws.readyState <= 1 /* CONNECTING | OPEN */) return;

    try {
        const ws = new WebSocket(wsUrl(docId));
        conn.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.addEventListener('open', async () => {
            const c = connections[docId];
            if (c) {
                c.reconnectDelay = RECONNECT_DELAY_INITIAL; // reset backoff on success
            }
            notifyListeners(docId, 'connected', { doc_id: docId });
            startPeerPoll(docId);

            // If WASM is available, start real sync. If not yet loaded, wait.
            const tryWasm = async () => {
                const aw = window.AutomergeWasm;
                if (!aw) return; // bootstrap not loaded yet
                if (aw.ready) {
                    initAutomergeState(docId);
                    sendSyncMessage(docId);
                    return;
                }
                // WASM not ready — wait for it, then try once
                try {
                    await aw.whenReady();
                    const c2 = connections[docId];
                    if (c2 && c2.ws && c2.ws.readyState === WebSocket.OPEN) {
                        initAutomergeState(docId);
                        sendSyncMessage(docId);
                    }
                } catch (_) {
                    // WASM failed — REST polling fallback already active
                }
            };
            tryWasm();
        });

        ws.addEventListener('message', (evt) => {
            const conn = connections[docId];
            // Identity check: ignore late-firing events from a socket that has
            // since been superseded (e.g. disconnect() → connect() raced with
            // this socket's async close). Without this, a stale socket's
            // message/close handlers can clobber the live connection's state.
            if (!conn || conn.ws !== ws) return;

            if (conn.wasmActive) {
                handleSyncMessage(docId, evt.data);
            }
            // else: binary messages ignored in fallback mode
        });

        ws.addEventListener('close', () => {
            const c = connections[docId];
            // Identity check: this socket may have already been superseded by
            // a newer one (disconnect() → connect() race) — its close event
            // firing late must be a no-op, not a clobber of the live conn.
            if (!c || c.ws !== ws) return;

            notifyListeners(docId, 'disconnected', { doc_id: docId });
            stopPeerPoll(docId);
            c.ws = null;
            c.wasmActive = false;
            // Keep doc/syncState for reconnect
            scheduleReconnect(docId);
        });

        ws.addEventListener('error', (e) => {
            console.warn('[crdt-sync] WS error for doc', docId, e);
        });
    } catch (e) {
        console.warn('[crdt-sync] failed to open WS for doc', docId, e);
        scheduleReconnect(docId);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const CrdtSyncClient = {
    /**
     * Connect to the CRDT sync WebSocket for a document.
     * Idempotent: multiple calls with the same docId re-use the same connection.
     *
     * @param {string} docId     - The document ID (CRDT project UUID)
     * @param {function} listener - Optional callback(event, payload)
     */
    async connect(docId, listener) {
        if (!(await isCloudMode())) return;

        if (!connections[docId]) {
            connections[docId] = freshConnState();
        }
        const conn = connections[docId];
        conn.explicitDisconnect = false;

        if (listener && !conn.listeners.includes(listener)) {
            conn.listeners.push(listener);
        }

        // Already connected or connecting — just ensure polling is active.
        if (conn.ws && conn.ws.readyState <= 1 /* CONNECTING | OPEN */) {
            startPeerPoll(docId);
            return;
        }

        clearReconnect(conn);
        conn.reconnectDelay = RECONNECT_DELAY_INITIAL;
        openSocket(docId);
    },

    /**
     * Disconnect from a document's sync WebSocket and stop polling.
     */
    disconnect(docId) {
        const conn = connections[docId];
        if (!conn) return;
        conn.explicitDisconnect = true;
        clearReconnect(conn);
        stopPeerPoll(docId);
        if (conn.ws) {
            try { conn.ws.close(); } catch (_) {}
            conn.ws = null;
        }
        conn.listeners = [];
        conn.doc = null;
        conn.syncState = null;
        conn.wasmActive = false;
        delete connections[docId];
    },

    /**
     * Get the last known peer count for a document.
     */
    peerCount(docId) {
        return connections[docId] ? connections[docId].peerCount : 0;
    },

    /**
     * Get the live Automerge.Doc for a document, or null if not yet hydrated.
     * @param {string} docId
     * @returns {object|null}
     */
    getDoc(docId) {
        const conn = connections[docId];
        return (conn && conn.wasmActive) ? conn.doc : null;
    },

    /**
     * Apply a local mutation to the document and broadcast the resulting
     * sync message to connected peers.
     *
     * @param {string} docId   - Document ID
     * @param {function} mutator - (doc) => void — receives a mutable proxy
     */
    change(docId, mutator) {
        const A = getAutomerge();
        const conn = connections[docId];
        if (!A || !conn || !conn.doc) {
            console.warn('[crdt-sync] change() called before WASM/doc ready for', docId);
            return;
        }
        try {
            conn.doc = A.change(conn.doc, mutator);
            sendSyncMessage(docId);
            notifyListeners(docId, 'change', {
                doc_id: docId,
                doc: conn.doc,
                changes: [],
                isLocal: true,
            });
        } catch (e) {
            console.warn('[crdt-sync] change() error for', docId, e);
        }
    },

    /**
     * Add an event listener for a document.
     * Events: 'connected', 'disconnected', 'peers', 'change'
     */
    addListener(docId, listener) {
        if (!connections[docId]) {
            connections[docId] = freshConnState();
        }
        const conn = connections[docId];
        if (!conn.listeners.includes(listener)) {
            conn.listeners.push(listener);
        }
    },

    /**
     * Remove an event listener.
     */
    removeListener(docId, listener) {
        const conn = connections[docId];
        if (!conn) return;
        conn.listeners = conn.listeners.filter(l => l !== listener);
    },
};

window.CrdtSyncClient = CrdtSyncClient;
