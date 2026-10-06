// Optional session-continuity hooks. Apps that participate in epic-7 task 16
// session migration register a save callback (returning a JSON-serialisable
// payload) and a restore callback (called with that payload on resume).
//
// Apps that don't register hooks resume with default state — the SDK never
// crashes if no hooks were set; `collect()` simply returns null.
import { debugLog } from "./internal.js";
const saveCallbacks = new Set();
const restoreCallbacks = new Set();
export const continuity = {
    onSessionSave(cb) {
        const wrapped = cb;
        saveCallbacks.add(wrapped);
        return () => saveCallbacks.delete(wrapped);
    },
    onSessionRestore(cb) {
        const wrapped = cb;
        restoreCallbacks.add(wrapped);
        return () => restoreCallbacks.delete(wrapped);
    },
    async collect() {
        if (saveCallbacks.size === 0)
            return null;
        // Multiple hooks merge into a single payload object — last-write-wins on
        // duplicate keys. Most apps register one hook; the merge supports a
        // future where library code (e.g. an editor framework) registers its own.
        const merged = {};
        for (const cb of saveCallbacks) {
            try {
                const value = await cb();
                if (value && typeof value === "object" && !Array.isArray(value)) {
                    Object.assign(merged, value);
                }
                else {
                    // Non-object payloads land under a default key so they're still
                    // recoverable. Apps with non-object state should restructure.
                    merged.value = value;
                }
            }
            catch (err) {
                console.error("fulcrumaxe-os continuity.onSessionSave callback threw:", err);
            }
        }
        debugLog(`continuity.collect: merged ${saveCallbacks.size} callback(s)`);
        return {
            version: 1,
            payload: merged,
            capturedAt: Date.now(),
        };
    },
    async apply(state) {
        if (restoreCallbacks.size === 0) {
            debugLog("continuity.apply: no restore callbacks registered, ignoring state");
            return;
        }
        for (const cb of restoreCallbacks) {
            try {
                await cb(state);
            }
            catch (err) {
                console.error("fulcrumaxe-os continuity.onSessionRestore callback threw:", err);
            }
        }
        debugLog(`continuity.apply: ran ${restoreCallbacks.size} callback(s)`);
    },
};
/** Public re-exports so apps can `import { onSessionSave } from "@fulc/sdk"`. */
export const onSessionSave = continuity.onSessionSave.bind(continuity);
export const onSessionRestore = continuity.onSessionRestore.bind(continuity);
//# sourceMappingURL=continuity.js.map