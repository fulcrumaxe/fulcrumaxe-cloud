// Shared DOM helpers for first-party apps (D#37 WS-F0b). Moved from the
// Developer app; no app copies them or imports another app's files.

// A minimal DOM builder: h("div", { class: "x", onClick: fn }, child, ...).
// It only ever calls createElement / createTextNode / setAttribute, so
// children are text, never markup. (The shell has the same helper in
// runtime/h.js; importing it would cost one more boot request, so the apps
// share this one.)
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === "class") el.className = String(v);
      else if (key.startsWith("on") && typeof v === "function") el.addEventListener(key.slice(2).toLowerCase(), v);
      else if (key in el) el[key] = v;
      else el.setAttribute(key, String(v));
    }
  }
  const add = (c) => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) c.forEach(add);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

function formatDate(iso, withTime) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function timeNode(iso, withTime) {
  return h("time", { datetime: iso, title: iso }, formatDate(iso, withTime));
}

export async function confirmAction(message) {
  // Refuse rather than proceed unconfirmed if the themed dialog is missing.
  if (typeof window.fulcConfirm !== "function") return false;
  return (await window.fulcConfirm(message)) === true;
}

/** "10:03:30 UTC" for an ISO time, or null when it is not one. UTC, like the other times the runner screens word (a reset time). */
export function clockText(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) + " UTC" : null;
}
