// TypeScript's `jsx: "react-jsx"` transform imports jsx/jsxs/Fragment from
// `<jsxImportSource>/jsx-runtime`. This file is that entry point; it delegates
// to h() so there's a single implementation. Props shape matches the transform:
// children live on props.children, not as rest args.
import { h } from "./h.js";
function fromProps(tag, props) {
    if (typeof tag === "function")
        return tag(props);
    const { children, ...rest } = props;
    const kids = children == null ? [] : Array.isArray(children) ? children : [children];
    return h(tag, rest, ...kids);
}
export function jsx(tag, props) {
    return fromProps(tag, props);
}
export function jsxs(tag, props) {
    return fromProps(tag, props);
}
export function Fragment(props) {
    const frag = document.createDocumentFragment();
    const kids = props.children;
    const list = kids == null ? [] : Array.isArray(kids) ? kids : [kids];
    for (const c of list) {
        if (c == null || c === false || c === true)
            continue;
        frag.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return frag;
}
//# sourceMappingURL=jsx-runtime.js.map