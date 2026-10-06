// Input the no-null-dom-insert lint test must leave alone.
import { h } from "../_lib/dom.js";

const line = (text) => h("p", null, text);

export function cases(st, headEl, host, items, node, rows) {
  // the fixed repos-app shape: the optional part is spread, not passed as null
  headEl.replaceChildren(h("h2", null, "Repos"), ...(st.isAdmin ? [] : [h("p", null, "Admin only")]));
  // h() and a same-file builder, text, numbers, concatenation
  host.replaceChildren(h("div", null, "x"), line("y"), "text", 3, "n=" + st.n, `t ${st.n}`);
  // DOM factories
  host.append(document.createElement("div"), document.createTextNode("t"), node.cloneNode(true));
  // a const holding a node
  const box = h("div", null);
  host.prepend(box);
  // truthy guards
  if (node) host.after(node);
  host.before(...(node ? [node] : []));
  node && host.append(node);
  // list spreads: map to nodes, filter(Boolean) over conditionals, a same-file list builder
  host.replaceChildren(...items.map((i) => h("li", null, i.name)));
  host.append(...[st.a ? h("p", null, "a") : null, st.b && h("p", null, "b")].filter(Boolean));
  function listOf(xs) {
    return xs.length ? xs.map((x) => line(x)) : [line("none")];
  }
  host.replaceChildren(...listOf(rows));
  // || and ?? fall back to a node
  host.append(st.custom || line("default"));
  // an opt-out comment with a reason
  // dom-insert-ok: rows[0] is always a built element here
  host.replaceWith(rows[0]);
  // not one of the six methods
  host.appendChild(node);
  host.insertBefore(node, null);
  host.setAttribute("x", null);
}
