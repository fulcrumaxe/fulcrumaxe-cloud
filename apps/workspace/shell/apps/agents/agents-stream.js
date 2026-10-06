// ── Agents JSON-Patch Stream ───────────────────────────────────────
// Pure logic for the {entries:[]} patch protocol plus a thin WebSocket
// controller. applyOp / dedupeOps / clone are exported so tests can
// exercise the 90% pure-logic tier without opening sockets.
/**
 * Apply a single RFC6902-style op to the {entries:[]} snapshot.
 * Tolerates "replace before add" (late-joining stream) by upserting.
 */
export function applyOp(target, op) {
    const match = op.path.match(/^\/entries\/(\d+)(\/.*)?$/);
    if (!match)
        return;
    const idx = parseInt(match[1], 10);
    const sub = match[2] || "";
    switch (op.op) {
        case "add":
            if (sub) {
                _setNested(target.entries[idx], sub, op.value);
            }
            else {
                target.entries.splice(idx, 0, op.value);
            }
            break;
        case "replace":
            if (sub) {
                _setNested(target.entries[idx], sub, op.value);
            }
            else {
                if (idx < target.entries.length) {
                    target.entries[idx] = op.value;
                }
                else {
                    while (target.entries.length < idx)
                        target.entries.push(null);
                    target.entries[idx] = op.value;
                }
            }
            break;
        case "remove":
            if (!sub && idx < target.entries.length) {
                target.entries.splice(idx, 1);
            }
            break;
    }
}
function _setNested(obj, subPath, value) {
    if (!obj)
        return;
    const parts = subPath.split("/").filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null)
            cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}
/**
 * Deduplicate ops targeting the same path within a single patch event.
 * Last write wins per path — EXCEPT "add" ops, which are never collapsed:
 * two "add" ops at different indices are distinct inserts (e.g. two new
 * entries arriving in the same patch event), not a redundant write to the
 * same logical slot. Collapsing them by path would silently drop one.
 * Order of kept ops is preserved.
 */
export function dedupeOps(ops) {
    const lastByPath = {};
    const kept = [];
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].op === "add") {
            kept.push(i);
        }
        else {
            lastByPath[ops[i].path] = i;
        }
    }
    for (const idx of Object.values(lastByPath)) {
        kept.push(idx);
    }
    kept.sort((a, b) => a - b);
    return kept.map((i) => ops[i]);
}
/**
 * Deep clone using structuredClone when available (modern browsers/Wry).
 */
export function clone(obj) {
    if (typeof structuredClone === "function")
        return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}
// ── Stream Controller ──────────────────────────────────────────────
/**
 * Connect to a WebSocket endpoint that emits:
 *   {"JsonPatch": [{op, path, value}, ...]}
 *   {"finished": ""}
 *
 * Maintains {entries:[]} snapshot. Returns a controller.
 */
export function streamEntries(url, opts) {
    opts = opts || {};
    let connected = false;
    let snapshot = { entries: [] };
    let subscribers = [];
    if (opts.onEntries)
        subscribers.push(opts.onEntries);
    const wsUrl = url.replace(/^http/, "ws");
    let ws;
    try {
        ws = new WebSocket(wsUrl);
    }
    catch (e) {
        if (opts.onError)
            opts.onError(e);
        return _makeController();
    }
    function notify() {
        for (let i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](snapshot.entries);
            }
            catch {
                /* swallow */
            }
        }
    }
    ws.addEventListener("open", () => {
        connected = true;
        if (opts.onConnect)
            opts.onConnect();
    });
    ws.addEventListener("message", (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.JsonPatch) {
                // Mutate the existing snapshot in place rather than structuredClone-ing
                // the entire entries list on every incoming message — with long-running
                // streams that list can grow into the thousands, and each patch event
                // only ever touches one or two entries.
                const ops = dedupeOps(msg.JsonPatch);
                for (let i = 0; i < ops.length; i++) {
                    applyOp(snapshot, ops[i]);
                }
                notify();
            }
            if (msg.finished !== undefined) {
                if (opts.onFinished)
                    opts.onFinished(snapshot.entries);
                ws.close();
            }
        }
        catch (err) {
            if (opts.onError)
                opts.onError(err);
        }
    });
    ws.addEventListener("error", (err) => {
        connected = false;
        if (opts.onError)
            opts.onError(err);
    });
    ws.addEventListener("close", () => {
        connected = false;
    });
    function _makeController() {
        return {
            getEntries() {
                return snapshot.entries;
            },
            getSnapshot() {
                return snapshot;
            },
            isConnected() {
                return connected;
            },
            onChange(cb) {
                subscribers.push(cb);
                cb(snapshot.entries);
                return () => {
                    const idx = subscribers.indexOf(cb);
                    if (idx >= 0)
                        subscribers.splice(idx, 1);
                };
            },
            close() {
                if (ws) {
                    try {
                        ws.close();
                    }
                    catch {
                        /* ignore */
                    }
                }
                subscribers = [];
                connected = false;
            },
        };
    }
    return _makeController();
}
/**
 * Load all entries from a WebSocket endpoint and resolve when finished.
 */
export function loadAllEntries(url) {
    return new Promise((resolve) => {
        const ctrl = streamEntries(url, {
            onFinished(entries) {
                ctrl.close();
                resolve(entries);
            },
            onError() {
                ctrl.close();
                resolve([]);
            },
        });
    });
}
export const FULCAgentsStream = {
    streamEntries,
    loadAllEntries,
};
window.FULCAgentsStream = FULCAgentsStream;
//# sourceMappingURL=agents-stream.js.map