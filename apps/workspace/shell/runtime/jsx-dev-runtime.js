// Dev-mode JSX import entrypoint. When a build or test runner is in
// dev mode (vitest via Vite), TypeScript's `jsx: "react-jsx"` transform
// looks up `<jsxImportSource>/jsx-dev-runtime` instead of `/jsx-runtime`.
// We delegate to the same underlying factory so prod and dev emit the
// same real-DOM nodes.
export { jsx, jsxs, Fragment } from "./jsx-runtime.js";
import { jsx } from "./jsx-runtime.js";
// The dev transform also passes a 6th arg (source/location) and uses
// `jsxDEV(tag, props, key, isStatic, source, self)`. We ignore the
// extras and forward to jsx — no debug hooks, no framework.
export function jsxDEV(tag, props) {
    return jsx(tag, props);
}
//# sourceMappingURL=jsx-dev-runtime.js.map