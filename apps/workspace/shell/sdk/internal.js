// Internal helpers shared across SDK modules. Not part of the public surface.
//
// Most of this file deals with one question: "what app id is this code running
// as?" The answer feeds into namespacing, proxy URLs, and the entitlement
// surface, so a single wrong guess cascades through the SDK.
//
// Resolution order (first match wins):
//   1. The id passed to `FULC.register({ id })` — explicit and authoritative.
//   2. `window.__FULC_BASEAPP_ID__` — set by the marketplace launcher (epic-12
//      task 04) before injecting the app's entry script.
//   3. The `data-baseapp-id` attribute on the `<script>` tag that loaded the
//      SDK — useful for plain-JS apps wired by hand.
//
// The id is cached after first resolution; subsequent calls return the same
// value so the proxy URL doesn't drift mid-session.
let resolvedAppId = null;
/** Set by `register()` after the dev hands us an explicit id. */
export function setAppId(id) {
    if (!id || typeof id !== "string") {
        throw new Error("fulcrumaxe-os SDK: app id must be a non-empty string");
    }
    if (resolvedAppId && resolvedAppId !== id) {
        console.warn(`fulcrumaxe-os SDK: app id changed from "${resolvedAppId}" to "${id}". The previous id was already used by namespaced state and proxy URLs — expect inconsistencies.`);
    }
    resolvedAppId = id;
}
/**
 * Best-effort app id resolution. Returns `null` if no source has supplied one.
 * Callers should treat `null` as "SDK not yet wired up" and surface a clear
 * error rather than silently falling back to a placeholder.
 */
export function getAppIdOrNull() {
    if (resolvedAppId)
        return resolvedAppId;
    if (typeof window !== "undefined") {
        const fromGlobal = window.__FULC_BASEAPP_ID__;
        if (typeof fromGlobal === "string" && fromGlobal.length > 0) {
            resolvedAppId = fromGlobal;
            return resolvedAppId;
        }
        // The script tag that loaded the SDK may carry `data-baseapp-id="…"`.
        // currentScript is null inside modules, so we sweep all <script> tags
        // looking for one that points at our bundle.
        if (typeof document !== "undefined") {
            const scripts = document.querySelectorAll("script[data-baseapp-id]");
            for (const s of Array.from(scripts)) {
                const id = s.dataset.baseappId;
                if (typeof id === "string" && id.length > 0) {
                    resolvedAppId = id;
                    return resolvedAppId;
                }
            }
        }
    }
    return null;
}
/** Throws a clear error when no app id has been resolved yet. */
export function requireAppId(operation) {
    const id = getAppIdOrNull();
    if (!id) {
        throw new Error(`fulcrumaxe-os SDK: ${operation} requires an app id. Call FULC.register({ id: "your.app.id", … }) first, or set window.__FULC_BASEAPP_ID__ before loading the SDK.`);
    }
    return id;
}
/** Optional verbose logging — turn on with `window.__FULC_DEV_LOG_SDK__ = true`. */
export function debugLog(msg, ...rest) {
    if (typeof window !== "undefined" && window.__FULC_DEV_LOG_SDK__) {
        console.debug(`[fulc-sdk] ${msg}`, ...rest);
    }
}
//# sourceMappingURL=internal.js.map