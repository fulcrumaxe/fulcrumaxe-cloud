// Deliberately rule-breaking input for the no-null-dom-insert lint test. Every numbered call must be reported.
import { h } from "../_lib/dom.js";

export function cases(st, headEl, host, items, maybe) {
  // 1: the original repos-app shape: a null in the middle of the arguments
  headEl.replaceChildren(h("h2", null, "Repos"), st.isAdmin ? null : h("p", null, "Admin only")); // FLAG
  // 2: literal null
  host.append(null); // FLAG
  // 3: literal undefined
  host.prepend(undefined); // FLAG
  // 4: a ?: with a nullish branch, the other way round
  host.before(st.ok ? h("p", null, "ok") : undefined); // FLAG
  // 5: && yields false / 0 / "" / null when the left side is falsy
  host.after(st.ok && h("p", null, "ok")); // FLAG
  // 6: an identifier that is not provably a node
  host.replaceWith(maybe); // FLAG
  // 7: a member that is not provably a node
  host.append(st.node); // FLAG
  // 8: a spread of a list that may hold null
  host.replaceChildren(...items.map((i) => (i.ok ? h("li", null, i.name) : null))); // FLAG
  // 9: a function in this file that sometimes returns nothing
  function sometimes(flag) {
    if (flag) return h("p", null, "x");
  }
  host.append(sometimes(st.flag)); // FLAG
  // 10: a let that is also assigned null
  let slot = h("p", null, "x");
  if (st.reset) slot = null;
  host.append(slot); // FLAG
  // 11: an opt-out comment without a reason does not count
  // dom-insert-ok:
  host.append(maybe); // FLAG
}
