// D#598 P8c: the Needs you app. One list of the steps people must do for the platform; today each row is a setup request (P8a and P8b).
//
// The page draws what needs-you-model.js reads. Every node is built with h(), so text from an agent (a request's title, reason and status sentence)
// is a text node and never markup. Controls use aria-disabled, not disabled, so a pressed control keeps focus while its request is in flight and a
// second press is ignored. When a row changes under the person, focus goes to the same control, else to the row's heading.
import { h } from "../_lib/dom.js";
import { onRefresh } from "../../core/cloud-live.js";
import { WORDS, createNeedsYou, notShownWords } from "./needs-you-model.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Needs you app: the FULC SDK global is missing");
}

function mountApp(contentEl) {
  const ac = new AbortController();
  const list = createNeedsYou({ signal: ac.signal, onChange: () => paint() });
  const root = h("div", { class: "ny-app", "data-testid": "ny-app" });
  contentEl.replaceChildren(root);

  const button = (row, verb, label) => {
    const working = list.busyVerb(row.id);
    return h(
      "button",
      {
        type: "button",
        class: "ny-btn",
        "data-testid": "ny-" + verb + "-" + row.id,
        "data-act": verb,
        "aria-disabled": working ? "true" : "false",
        "aria-label": label + ": " + row.title,
        onClick: () => {
          if (!list.busyVerb(row.id)) list.act(row.id, verb);
        },
      },
      label
    );
  };

  // One button per option of an ask, and Deny. The agent's option names are text nodes; the recommended one says so in its accessible name too.
  const choiceButton = (row, choice, label, recommended) => {
    const working = list.busyVerb(row.id);
    return h(
      "button",
      {
        type: "button",
        class: "ny-btn",
        "data-testid": "ny-choice-" + row.id + "-" + choice,
        "data-act": "choice-" + choice,
        "aria-disabled": working ? "true" : "false",
        "aria-label": label + (recommended ? " (" + WORDS.recommended.toLowerCase() + ")" : "") + ": " + row.title,
        onClick: () => {
          if (!list.busyVerb(row.id)) list.answer(row.id, choice);
        },
      },
      label
    );
  };

  function askView(row) {
    const headId = "ny-h-" + row.id;
    const working = list.busyVerb(row.id);
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "ask", "data-id": row.id, "data-state": row.state, "aria-busy": working ? "true" : "false" },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      row.state === "open" ? null : h("p", { class: "ny-state", "data-testid": "ny-state" }, row.sentence),
      row.state === "open" && row.overdue ? h("p", { class: "ny-state", "data-testid": "ny-overdue" }, WORDS.overdue) : null,
      row.state === "open" && row.proposedLabel ? h("p", { class: "ny-proposed", "data-testid": "ny-proposed" }, WORDS.recommended + ": " + row.proposedLabel) : null,
      // The agent's reason is a quotation: a text node inside a blockquote, never markup and never an instruction.
      row.reason ? h("blockquote", { class: "ny-quote", "data-testid": "ny-reason" }, row.reason) : null,
      row.state === "open"
        ? h("div", { class: "ny-actions" }, row.options.map((o) => choiceButton(row, o.id, o.label, o.id === row.proposed)).concat(choiceButton(row, "deny", WORDS.deny, false)))
        : null
    );
  }

  // A pull request waiting for a person: its words and one link to GitHub. No buttons: merging happens there, and the row leaves on the next read.
  function mergeView(row) {
    const headId = "ny-h-" + row.id;
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "merge", "data-id": row.id, "data-state": row.state },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, row.sentence),
      row.reason ? h("p", { class: "ny-reason", "data-testid": "ny-reason" }, row.reason) : null,
      row.link ? h("p", null, h("a", { class: "ny-link", href: row.link.href, target: "_blank", rel: "noopener noreferrer", "aria-describedby": headId, "data-testid": "ny-link" }, WORDS.openPr)) : null
    );
  }

  // An item that stopped on its own: what stopped, in the cloud's words, and the card's own top button (or, where none applies, a line to open the card).
  function stalledView(row) {
    const headId = "ny-h-" + row.id;
    const working = list.busyVerb(row.id);
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "stalled", "data-id": row.id, "data-state": row.state, "aria-busy": working ? "true" : "false" },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      row.reason ? h("p", { class: "ny-reason", "data-testid": "ny-reason" }, row.reason) : null,
      row.sentence ? h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, row.sentence) : null,
      row.action
        ? h(
            "div",
            { class: "ny-actions" },
            h(
              "button",
              {
                type: "button",
                class: "ny-btn",
                "data-testid": "ny-unstick-" + row.id,
                "data-act": "unstick",
                "aria-disabled": working ? "true" : "false",
                "aria-label": row.action + ": " + row.title,
                onClick: () => {
                  if (!list.busyVerb(row.id)) list.unstick(row.id);
                },
              },
              row.action
            )
          )
        : null
    );
  }

  function rowView(row) {
    if (row.kind === "stalled") return stalledView(row);
    if (row.kind === "ask") return askView(row);
    if (row.kind === "merge") return mergeView(row);
    const working = list.busyVerb(row.id);
    const headId = "ny-h-" + row.id;
    // While Mark done is in flight on a request with an automatic check, the approved "Checking now." stands in for the answer.
    const sentence = working === "done" && row.hasCheck ? WORDS.checkingNow : row.sentence;
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-id": row.id, "data-state": row.state, "aria-busy": working ? "true" : "false" },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      row.state === "open" ? null : h("p", { class: "ny-state", "data-testid": "ny-state" }, row.state === "done" ? WORDS.done : WORDS.withdrawn),
      row.reason ? h("p", { class: "ny-reason", "data-testid": "ny-reason" }, row.reason) : null,
      sentence ? h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, sentence) : null,
      row.link ? h("p", null, h("a", { class: "ny-link", href: row.link.href, target: "_blank", rel: "noopener noreferrer", "aria-describedby": headId, "data-testid": "ny-link" }, row.link.host)) : null,
      row.state === "open" ? h("div", { class: "ny-actions" }, button(row, "done", WORDS.markDone), button(row, "withdraw", WORDS.withdraw)) : null
    );
  }

  // The heading, the live region and the alert are made once and live outside the part that is redrawn. A redraw would otherwise insert them again
  // already filled with the old text, and a screen reader would say it again on every refresh. Their text is set only when it changes.
  const heading = h("h2", { class: "ny-title", id: "ny-heading", tabindex: "-1" }, WORDS.title);
  const live = h("p", { class: "ny-live", role: "status", "aria-live": "polite", "data-testid": "ny-live" });
  const alertEl = h("p", { class: "ny-error", role: "alert", "data-testid": "ny-action-error" });
  const content = h("div", { class: "ny-content" });
  root.replaceChildren(h("div", { class: "ny-page" }, heading, live, alertEl, content));
  const setText = (el, value) => {
    if (el.textContent !== value) el.textContent = value;
  };

  function paint() {
    const s = list.state;
    const held = root.ownerDocument.activeElement;
    const heldRow = held && content.contains(held) && held.closest ? held.closest("[data-id]") : null;
    const heldKey = heldRow ? [heldRow.getAttribute("data-id"), held.getAttribute("data-act") || ""] : null;
    const openCount = s.rows.filter((r) => r.state === "open").length;
    const body =
      s.status === "loading" ? h("p", { class: "ny-muted", role: "status", "data-testid": "ny-loading" }, WORDS.loading)
      : s.status === "error" ? h("p", { class: "ny-error", role: "alert", "data-testid": "ny-error" }, WORDS.error)
      : s.rows.length === 0 ? h("p", { class: "ny-muted", "data-testid": "ny-empty" }, WORDS.empty)
      : h("ul", { class: "ny-rows", "data-testid": "ny-rows" }, s.rows.map(rowView));
    setText(heading, WORDS.title + (s.status === "ready" ? " (" + openCount + ")" : ""));
    if (s.announce !== "") {
      live.textContent = s.announce;
      list.clearAnnounce(); // said once; a later draw does not say it again
    } else if (list.anyBusy()) {
      live.textContent = ""; // a new action starts: the same sentence can be said again when it ends
    }
    setText(alertEl, s.error);
    content.replaceChildren(body);
    if (s.status === "ready" && s.notShown > 0) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-not-shown" }, notShownWords(s.notShown)));
    if (s.status === "ready" && s.truncated) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-older" }, WORDS.older));
    if (heldKey) {
      const row = [...content.querySelectorAll("[data-id]")].find((r) => r.getAttribute("data-id") === heldKey[0]);
      const again = row && heldKey[1] ? [...row.querySelectorAll("[data-act]")].find((b) => b.getAttribute("data-act") === heldKey[1]) : null;
      (again || (row && row.querySelector("h3")) || heading).focus();
    }
  }

  paint();
  list.load();
  list.start({ subscribe: onRefresh, hidden: () => document.hidden });
  return {
    destroy() {
      list.stop();
      ac.abort();
      contentEl.replaceChildren();
    },
  };
}

let current = null;

FULC.register({
  id: "needs-you",
  title: "Needs you",
  icon: "◉",
  defaultSize: { w: 720, h: 560 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountApp(contentEl);
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
