// In-app pub/sub bus + cross-context BroadcastChannel for the same app id.
//
// `on/off/emit` stay inside the current document. `broadcast()` additionally
// publishes to a `BroadcastChannel("fulc:app:<id>")` so other fulcrumaxe-os contexts
// (e.g. a popped-out window or a worker) running the same app receive the
// event too. The local listeners always fire — broadcast is "in addition to,"
// not "instead of."
import { requireAppId, debugLog } from "./internal.js";
const localListeners = new Map();
let channel = null;
let channelAppId = null;
function ensureChannel() {
    if (typeof BroadcastChannel === "undefined")
        return null;
    const appId = requireAppId("events.broadcast");
    if (channel && channelAppId === appId)
        return channel;
    if (channel) {
        try {
            channel.close();
        }
        catch {
            /* ignore */
        }
    }
    channelAppId = appId;
    channel = new BroadcastChannel("fulc:app:" + appId);
    channel.onmessage = (e) => {
        const data = e.data;
        if (!data || typeof data.type !== "string")
            return;
        fire(data.type, data.payload);
    };
    debugLog(`events: opened BroadcastChannel "fulc:app:${appId}"`);
    return channel;
}
function fire(event, payload) {
    const set = localListeners.get(event);
    if (!set)
        return;
    for (const fn of Array.from(set)) {
        try {
            fn(payload);
        }
        catch (err) {
            console.error(`fulcrumaxe-os events listener for "${event}" threw:`, err);
        }
    }
}
export const events = {
    on(event, listener) {
        let set = localListeners.get(event);
        if (!set) {
            set = new Set();
            localListeners.set(event, set);
        }
        const wrapped = listener;
        set.add(wrapped);
        return () => set.delete(wrapped);
    },
    off(event, listener) {
        localListeners.get(event)?.delete(listener);
    },
    emit(event, payload) {
        fire(event, payload);
    },
    broadcast(event, payload) {
        fire(event, payload);
        const ch = ensureChannel();
        if (ch) {
            try {
                ch.postMessage({ type: event, payload });
            }
            catch (err) {
                console.warn(`fulcrumaxe-os events.broadcast("${event}") failed:`, err);
            }
        }
    },
};
//# sourceMappingURL=events.js.map