// `@fulc/sdk` entry point — re-exports the public API and (when loaded in the
// browser) assigns the same surface to `window.FULC` so plain-JS marketplace
// apps can use it via `<script type="module">` without any imports of their
// own.
//
// Two equivalent consumption modes:
//
//   • TypeScript / ESM apps:
//       import { register, backend, state } from "../sdk/fulc-sdk.js";
//
//   • Plain JavaScript apps:
//       <script type="module" src="/sdk/fulc-sdk.js"></script>
//       <script>FULC.register({ id: "com.example.foo", title: "Foo" });</script>
//
//   • Plain JavaScript apps with no module support (UMD bundle):
//       <script src="/sdk/fulc-sdk.umd.js"></script>
//       <script>FULC.register({ id: "com.example.foo", title: "Foo" });</script>
import { register, ready, destroy } from "./app.js";
import { request, openWS, FULCBackendError } from "./backend.js";
import { state } from "./state.js";
import { config } from "./config.js";
import { events } from "./events.js";
import { theme } from "./theme.js";
import { entitlements } from "./entitlements.js";
import { windowApi } from "./window.js";
import { continuity, onSessionSave, onSessionRestore, } from "./continuity.js";
export { register, ready, destroy } from "./app.js";
export { request, openWS, FULCBackendError } from "./backend.js";
export { state } from "./state.js";
export { config } from "./config.js";
export { events } from "./events.js";
export { theme } from "./theme.js";
export { entitlements } from "./entitlements.js";
export { windowApi as window } from "./window.js";
export { onSessionSave, onSessionRestore } from "./continuity.js";
/**
 * SDK version, written in by the build pipeline. Rendered as a string so the
 * SDK can compare against `min_fulc_version` in manifests at install time.
 */
export const VERSION = "0.1.0";
/** The grouped `FULC` namespace mirrored on `window.FULC`. */
export const FULC = {
    VERSION,
    register,
    ready,
    destroy,
    backend: { request, openWS, FULCBackendError },
    state,
    config,
    events,
    theme,
    entitlements,
    window: windowApi,
    continuity,
    onSessionSave,
    onSessionRestore,
};
// `window.FULC` is declared (loosely typed) in `src-ts/types/fulc.d.ts` so a
// re-declaration here would conflict. External consumers get the typed
// surface from the published `assets/sdk/fulc-sdk.d.ts` instead, and internal
// callers should `import type { FULC } from "../sdk/fulc-sdk.js"` when they
// want full IntelliSense.
if (typeof window !== "undefined") {
    // Don't clobber an existing fulcrumaxe-os namespace — a host that injected an
    // augmented variant (tests, custom launcher) already has the surface they
    // want. If two SDK builds load in the same context, last-write-wins.
    // The deprecated pre-rename alias of this global is an accessor installed by
    // core/fulc-global-aliases (D#922 decision 5), not a second assignment here.
    if (!window.FULC) {
        window.FULC = FULC;
    }
    else {
        console.warn("fulcrumaxe-os SDK: window.FULC already defined; not overwriting. If you intentionally loaded the SDK twice, the second copy is using the first's namespace.");
    }
}
export default FULC;
//# sourceMappingURL=fulc-sdk.js.map