// Per-app `localStorage` wrapper. Every key is namespaced with
// `fx:<storage_ns>:app:<id>:` so two apps can't collide on the same key,
// AND two accounts sharing a browser can't collide on the same app's
// key (D#37 WS-C2 fix round item 3, W2, CWE-359) -- `<storage_ns>` is
// the same opaque per-account value every other fx:<ns>: writer in this
// fork uses (core/storage-ns.js). JSON-serialises values transparently
// — `state.set("count", 5); state.get<number>("count")` returns the
// typed value.
import { requireAppId, debugLog } from "./internal.js";
import { getNamespace, PREFIX } from "../core/storage-ns.js";
/**
 * Returns null (never an un-namespaced key) until a namespace exists --
 * matches storage-ns.js's own getItem/setItem contract, so no SDK write
 * can fall back to an un-namespaced key before sign-in has resolved one.
 */
function namespace() {
    const ns = getNamespace();
    if (!ns) return null;
    return PREFIX + ns + ":app:" + requireAppId("state.*") + ":";
}
function ls() {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    }
    catch {
        // Some sandboxed contexts throw on access. Fall back to in-memory.
        return null;
    }
}
const memoryFallback = new Map();
function readRaw(fullKey) {
    const store = ls();
    if (store)
        return store.getItem(fullKey);
    return memoryFallback.get(fullKey) ?? null;
}
function writeRaw(fullKey, value) {
    const store = ls();
    if (store) {
        store.setItem(fullKey, value);
    }
    else {
        memoryFallback.set(fullKey, value);
    }
}
function removeRaw(fullKey) {
    const store = ls();
    if (store) {
        store.removeItem(fullKey);
    }
    else {
        memoryFallback.delete(fullKey);
    }
}
function listKeys(prefix) {
    const store = ls();
    const out = [];
    if (store) {
        for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k && k.startsWith(prefix))
                out.push(k.slice(prefix.length));
        }
    }
    else {
        for (const k of memoryFallback.keys()) {
            if (k.startsWith(prefix))
                out.push(k.slice(prefix.length));
        }
    }
    return out;
}
export const state = {
    get(key) {
        const ns = namespace();
        if (ns === null)
            return null;
        const raw = readRaw(ns + key);
        if (raw === null)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch (err) {
            console.warn(`fulcrumaxe-os state.get("${key}"): unparseable JSON, returning null`, err);
            return null;
        }
    },
    set(key, value) {
        const ns = namespace();
        // No namespace yet -- a no-op, never a write under an
        // un-namespaced key (D#37 WS-C2 fix round item 3, W2).
        if (ns === null) {
            debugLog(`state.set("${key}") skipped: no namespace yet`);
            return;
        }
        let serialised;
        try {
            serialised = JSON.stringify(value);
        }
        catch (err) {
            throw new Error(`fulcrumaxe-os state.set("${key}"): value not JSON-serialisable: ${err.message}`);
        }
        writeRaw(ns + key, serialised);
        debugLog(`state.set("${key}") = ${serialised.length}b`);
    },
    remove(key) {
        const ns = namespace();
        if (ns === null)
            return;
        removeRaw(ns + key);
    },
    clear() {
        const ns = namespace();
        if (ns === null)
            return;
        for (const key of listKeys(ns)) {
            removeRaw(ns + key);
        }
        debugLog(`state.clear() under ${ns}`);
    },
    keys() {
        const ns = namespace();
        if (ns === null)
            return [];
        return listKeys(ns);
    },
};
//# sourceMappingURL=state.js.map