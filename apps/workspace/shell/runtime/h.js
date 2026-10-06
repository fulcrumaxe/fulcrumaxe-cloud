// Real-DOM JSX factory for fulcrumaxe-os. Returns HTMLElement nodes, not a VDOM.
// Contract: <div class="x">{y}</div> compiles to h("div", {class: "x"}, y)
// and produces the same DOM tree as document.createElement + manual assembly.
// No framework, no reconciler, no synthetic events. Text children auto-escape.
export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const key in props) {
            const v = props[key];
            if (v == null || v === false)
                continue;
            if (key === "class" || key === "className")
                el.className = String(v);
            else if (key === "style" && typeof v === "object")
                Object.assign(el.style, v);
            else if (key.startsWith("on") && typeof v === "function")
                el.addEventListener(key.slice(2).toLowerCase(), v);
            else if (key in el)
                el[key] = v;
            else
                el.setAttribute(key, String(v));
        }
    }
    const append = (c) => {
        if (c == null || c === false || c === true)
            return;
        if (Array.isArray(c))
            c.forEach(append);
        else if (c instanceof Node)
            el.appendChild(c);
        else
            el.appendChild(document.createTextNode(String(c)));
    };
    children.forEach(append);
    return el;
}
export default h;
//# sourceMappingURL=h.js.map