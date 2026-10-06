// App lifecycle: bridges FULC.register({…}) to the desktop's `FULCApps`
// registry + window manager. This is the entry point every marketplace app
// calls at top level.
import { setAppId, getAppIdOrNull, debugLog } from "./internal.js";
let isReady = false;
const readyCallbacks = [];
function fulcApps() {
    if (typeof window === "undefined")
        return null;
    const apps = window.FULCApps;
    return apps && typeof apps.register === "function" ? apps : null;
}
function fulcWM() {
    if (typeof window === "undefined")
        return null;
    return window.FULCWM ?? null;
}
/**
 * Register the app with the fulcrumaxe-os desktop. Resolves the app id, wires the
 * lifecycle hooks into `FULCApps.register`, and marks the SDK as ready so
 * `ready()` callbacks fire.
 *
 * Calling `register` twice for the same id is a no-op — the existing
 * registration wins. This matches the desktop's tolerate-double-init
 * behaviour for hot reload.
 */
export function register(options) {
    if (!options || typeof options !== "object") {
        throw new TypeError("FULC.register: options object is required");
    }
    if (!options.title || typeof options.title !== "string") {
        throw new TypeError("FULC.register: `title` is required");
    }
    const id = options.id ??
        getAppIdOrNull() ??
        (() => {
            throw new Error("FULC.register: no app id resolved. Pass `id` explicitly or set window.__FULC_BASEAPP_ID__ before the SDK loads.");
        })();
    setAppId(id);
    const apps = fulcApps();
    if (!apps) {
        // Defer the registration until FULCApps shows up. This happens when the
        // SDK is loaded before the core app-registry module — rare in practice
        // (the launcher always loads core first), but worth tolerating.
        debugLog(`register("${id}") deferred — FULCApps not yet available`);
        queueMicrotask(() => register(options));
        return;
    }
    if (typeof apps.get === "function" && apps.get(id)) {
        debugLog(`register("${id}"): already registered, skipping`);
        markReady();
        return;
    }
    const def = {
        id,
        title: options.title,
        icon: options.icon,
        defaultSize: options.defaultSize,
        minSize: options.minSize,
        onOpen: (contentEl, launchArg) => {
            const ctx = { appId: id, contentEl, launchArg };
            try {
                const result = options.onOpen?.(ctx);
                if (result && typeof result.then === "function") {
                    result.catch((err) => {
                        console.error(`fulcrumaxe-os app "${id}" onOpen() rejected:`, err);
                    });
                }
            }
            catch (err) {
                console.error(`fulcrumaxe-os app "${id}" onOpen() threw:`, err);
            }
        },
        onClose: options.onClose ? (appId) => options.onClose?.(appId) : undefined,
        onFocus: options.onFocus ? (appId) => options.onFocus?.(appId) : undefined,
        onResize: options.onResize ? () => options.onResize?.(id) : undefined,
        onHide: options.onHide ? () => options.onHide?.(id) : undefined,
        onShow: options.onShow ? () => options.onShow?.(id) : undefined,
        onLaunch: options.onLaunch ? (launchArg) => options.onLaunch?.({ appId: id, launchArg }) : undefined,
    };
    apps.register(id, def);
    debugLog(`register("${id}"): wired with title="${options.title}"`);
    markReady();
}
function markReady() {
    if (isReady)
        return;
    isReady = true;
    const cbs = readyCallbacks.splice(0);
    for (const cb of cbs) {
        try {
            cb();
        }
        catch (err) {
            console.error("FULC.ready callback threw:", err);
        }
    }
}
/**
 * Run a callback once the app is registered with fulcrumaxe-os. Fires immediately if
 * the app is already registered, otherwise queues until `register()` returns.
 *
 * Use this for setup code that depends on the SDK knowing its app id (e.g.
 * preloading state, opening a WebSocket).
 */
export function ready(cb) {
    if (isReady) {
        queueMicrotask(cb);
    }
    else {
        readyCallbacks.push(cb);
    }
}
/**
 * Tear down the app: close any open window and unregister. Call this from
 * the parent extension/host when the app is being uninstalled. Most apps
 * don't need to call this themselves — the desktop drives uninstall.
 */
export function destroy() {
    const id = getAppIdOrNull();
    if (!id)
        return;
    const wm = fulcWM();
    try {
        if (wm?.isOpen?.(id))
            wm.close?.(id);
    }
    catch (err) {
        console.warn(`FULC.destroy: failed to close window for "${id}":`, err);
    }
    const apps = fulcApps();
    try {
        apps?.unregister?.(id);
    }
    catch (err) {
        console.warn(`FULC.destroy: failed to unregister "${id}":`, err);
    }
}
//# sourceMappingURL=app.js.map