// D#601 MEM-4a3: the review queue. One card per proposal (body, who proposed it, evidence, whether this person opened it), with Approve,
// Edit then approve and Reject, the keyboard (A, E and R on the focused card, then focus moves to the next), and batch decisions inside one source
// behind a dialog that names the count and the source. Text only, built with h(); every string from the server goes through text().
//
// The rules (one source per batch, opened before batched, rights, secret scan) are the server's. A gated card (imported or runner-sourced) shows its
// title only until it is opened; opening records it on the server, and the batch buttons stay disabled, saying how many cards are left, until none is.
import { h } from "../_lib/dom.js";
import {
  COPY, batchButtonWords, batchesOf, byteLength, checkEdit, decideBatch, decideOne, editEntry, failureWords, isGated, isOpened, openCard, scopesOfCards, text, waitingWords, KINDS,
  MEMORY_BODY_MAX_BYTES, MEMORY_WHY_MAX_BYTES,
} from "./memory-storage.js";

const isField = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT");

/**
 * host: the element the queue lives in. places: label -> { kind, id } for the badge lookup. countFor(place|null, cards) -> number|null.
 * reload(focusId): re-read everything, then focus that card (or the queue heading when it is gone). get: the fetch helper (the shared api by default).
 */
export function mountQueue({ host, countFor, reload, get }) {
  let cards = [];
  let phase = "loading"; // loading | ready | error
  let truncated = false;
  let places = new Map();
  let editing = null; // the id of the card being edited
  let busy = new Set(); // card ids with a call in flight
  const cardErrors = new Map();
  let dialog = null; // { dlg, from }

  const heading = h("h2", { class: "mem-h", tabindex: "-1", "data-testid": "mem-queue-heading" }, COPY.queueTitle);
  const body = h("div", { "data-testid": "mem-queue" });
  host.replaceChildren(heading, body);

  const cardEl = (id) => host.querySelector('[data-card="' + id + '"]');
  const orderedIds = () => [...host.querySelectorAll("[data-card]")].map((e) => e.getAttribute("data-card"));

  function nextIdAfter(id) {
    const ids = orderedIds();
    const i = ids.indexOf(id);
    return i >= 0 && i + 1 < ids.length ? ids[i + 1] : i > 0 ? ids[i - 1] : null;
  }

  async function act(card, fn) {
    const id = card.entry.id;
    if (busy.has(id)) return;
    busy.add(id);
    cardErrors.delete(id);
    const next = nextIdAfter(id);
    paint();
    try {
      await fn();
      busy.delete(id);
      editing = null;
      await reload(next);
    } catch (e) {
      busy.delete(id);
      if (e && e.name === "AbortError") return;
      cardErrors.set(id, failureWords(e));
      // A refusal that means the entry changed or is gone: the list is stale, so read it again (the message stays).
      if (e && (e.status === 404 || e.code === "conflict")) await reload(null);
      else paint();
      const el = cardEl(id);
      if (el) el.focus();
    }
  }

  const approve = (card) => act(card, () => decideOne(card.entry.id, "approved", get));
  const reject = (card) => act(card, () => decideOne(card.entry.id, "rejected", get));
  const open = (card) => act(card, () => openCard(card.entry.id, get));

  function startEdit(card) {
    // Callers only offer edit on a card that is open (a shut gated card shows Open instead), so no branch here.
    editing = card.entry.id;
    paint();
    const t = host.querySelector('[data-card="' + card.entry.id + '"] textarea');
    if (t) t.focus();
  }

  function editor(card) {
    const e = card.entry;
    const area = h("textarea", { id: "mem-edit-" + e.id, class: "mem-input", rows: 4, "data-testid": "mem-edit-body", "aria-describedby": "mem-edit-help-" + e.id }, text(e.body));
    const why = h("input", { type: "text", id: "mem-why-" + e.id, class: "mem-input", autocomplete: "off", value: text(e.why), "data-testid": "mem-edit-why" });
    const kind = h("select", { id: "mem-kind-" + e.id, class: "mem-input", "data-testid": "mem-edit-kind" }, KINDS.map(([v, label]) => h("option", { value: v, selected: v === e.kind }, label)));
    const count = h("span", { id: "mem-edit-help-" + e.id, class: "mem-muted" });
    const err = h("p", { class: "mem-error", role: "alert", tabindex: "-1", "data-testid": "mem-edit-error" });
    const update = () => (count.textContent = byteLength(area.value) + " of " + MEMORY_BODY_MAX_BYTES + " bytes");
    area.addEventListener("input", update);
    update();
    const submit = (approveAfter) => () => {
      const bad = checkEdit(area.value, why.value);
      if (bad) {
        err.textContent = bad;
        err.focus();
        return;
      }
      act(card, async () => {
        const saved = await editEntry(e.id, { body: area.value, why: why.value, kind: kind.value }, get);
        if (approveAfter) await decideOne(saved.entry.id, "approved", get);
      });
    };
    const btn = (label, testid, onClick, secondary) => h("button", { type: "button", class: "mem-btn" + (secondary ? " mem-btn-quiet" : ""), "data-testid": testid, onClick }, label);
    return h(
      "form",
      { class: "mem-edit", "data-testid": "mem-editor", onSubmit: (ev) => ev.preventDefault(), onKeydown: (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); editing = null; paint(); const c = cardEl(e.id); if (c) c.focus(); } } },
      h("label", { for: area.id }, "Memory"),
      area,
      count,
      h("label", { for: why.id }, "Why (optional, up to " + MEMORY_WHY_MAX_BYTES + " bytes)"),
      why,
      h("label", { for: kind.id }, "Kind"),
      kind,
      err,
      h("div", { class: "mem-actions" }, btn("Approve with this edit", "mem-edit-approve", submit(true)), btn("Save without approving", "mem-edit-save", submit(false), true), btn("Cancel", "mem-edit-cancel", () => { editing = null; paint(); const c = cardEl(e.id); if (c) c.focus(); }, true))
    );
  }

  function cardNode(card) {
    const e = card.entry;
    const id = e.id;
    const gated = isGated(card);
    const opened = isOpened(card);
    const working = busy.has(id);
    const shut = gated && !opened;
    const disabled = working ? { "aria-disabled": "true" } : {};
    const act1 = (label, key, testid, fn) => h("button", { type: "button", class: "mem-btn", "aria-keyshortcuts": key.toUpperCase(), "data-testid": testid, ...disabled, onClick: () => !working && fn(card) }, label);
    const why = text(e.why);
    const evidence = text(card.evidence);
    return h(
      "article",
      {
        class: "mem-card" + (working ? " mem-busy" : ""),
        tabindex: "0",
        "data-card": id,
        "data-testid": "mem-card",
        "data-open-state": text(card.open_state, "not_required"),
        "aria-label": text(card.kind_label, "Memory") + ": " + text(card.title, COPY.unknownSource),
        onKeydown: (ev) => {
          if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || isField(ev.target) || editing === id) return;
          const k = ev.key.toLowerCase();
          if (k !== "a" && k !== "e" && k !== "r") return;
          ev.preventDefault();
          if (working) return;
          if (shut) return void open(card); // the first key on a card nobody opened opens it; the next one acts
          if (k === "a") approve(card);
          else if (k === "e") startEdit(card);
          else reject(card);
        },
      },
      h("div", { class: "mem-card-head" }, h("span", { class: "mem-chip" }, text(card.kind_label, "Memory")), h("span", { class: "mem-muted" }, text(card.age))),
      shut ? h("p", { class: "mem-title", "data-testid": "mem-card-title" }, text(card.title, COPY.unknownSource)) : editing === id ? editor(card) : h("p", { class: "mem-text", "data-testid": "mem-card-body" }, text(e.body)),
      !shut && editing !== id && why ? h("p", { class: "mem-muted", "data-testid": "mem-card-why" }, "Why: " + why) : null,
      h("p", { class: "mem-prov", "data-testid": "mem-card-proposed-by" }, text(card.proposed_by, COPY.unknownSource)),
      !shut && evidence ? h("p", { class: "mem-muted", "data-testid": "mem-card-evidence" }, "Evidence: " + evidence) : null,
      gated ? h("p", { class: "mem-open-state", "data-testid": "mem-open-state" }, (opened ? "✓ " : "○ ") + (opened ? COPY.opened : COPY.notOpened)) : null,
      editing === id
        ? null
        : h(
            "div",
            { class: "mem-actions" },
            shut
              ? h("button", { type: "button", class: "mem-btn", "data-testid": "mem-open", ...disabled, onClick: () => !working && open(card) }, COPY.openCard)
              : [act1(COPY.approve, "a", "mem-approve", approve), act1(COPY.editThenApprove, "e", "mem-edit", startEdit), act1(COPY.reject, "r", "mem-reject", reject)]
          ),
      working ? h("p", { class: "mem-muted", role: "status" }, "Working…") : null,
      cardErrors.has(id) ? h("p", { class: "mem-error", role: "alert", "data-testid": "mem-card-error" }, cardErrors.get(id)) : null
    );
  }

  // ── a batch: the dialog names the count and the source, focus returns to the button that opened it ──
  function closeDialog() {
    if (!dialog) return;
    const { dlg, from } = dialog;
    dialog = null;
    dlg.close();
    dlg.remove();
    const back = from && host.contains(from) ? from : host.querySelector("[data-card]") || heading;
    back.focus();
  }

  function openBatch(batch, to, from) {
    const verb = to === "approved" ? "Approve" : "Reject";
    const count = batch.size;
    const err = h("p", { class: "mem-error", role: "alert", tabindex: "-1", "data-testid": "mem-batch-error" });
    const yes = h("button", { type: "button", class: "mem-btn", "data-testid": "mem-batch-confirm" }, verb + " " + count + " cards");
    const no = h("button", { type: "button", class: "mem-btn mem-btn-quiet", "data-testid": "mem-batch-cancel", onClick: closeDialog }, "Cancel");
    yes.addEventListener("click", async () => {
      if (yes.getAttribute("aria-disabled") === "true") return;
      yes.setAttribute("aria-disabled", "true");
      err.textContent = "";
      const first = batch.cards[0].entry.id;
      try {
        await decideBatch(batch.cards.map((c) => c.entry.id), to, get);
      } catch (e) {
        yes.setAttribute("aria-disabled", "false");
        err.textContent = failureWords(e);
        err.focus();
        if (e && (e.code === "must_open_first" || e.code === "conflict" || e.status === 404)) reload(null, true);
        return;
      }
      closeDialog();
      await reload(nextIdAfterBatch(batch, first));
    });
    const dlg = h(
      "dialog",
      { class: "mem-dialog", "aria-labelledby": "mem-batch-h", "data-testid": "mem-batch-dialog", onCancel: (ev) => (ev.preventDefault(), closeDialog()) },
      h(
        "div",
        { class: "mem-dialog-body" },
        h("h2", { id: "mem-batch-h", class: "mem-h" }, verb + " " + count + " cards from " + batch.source + "?"),
        h("p", null, verb === "Approve" ? "All " + count + " cards from " + batch.source + " are approved together. If one can't be approved, none is." : "All " + count + " cards from " + batch.source + " are rejected together. If one can't be rejected, none is."),
        err,
        h("div", { class: "mem-actions" }, yes, no)
      )
    );
    host.ownerDocument.body.appendChild(dlg);
    dlg.showModal();
    dialog = { dlg, from };
    yes.focus();
  }

  function nextIdAfterBatch(batch) {
    const gone = new Set(batch.cards.map((c) => c.entry.id));
    return orderedIds().find((i) => !gone.has(i)) || null;
  }

  function batchBar(batch) {
    if (batch.size < 2) return null;
    const blocked = batch.unopened > 0 || batch.size > 20;
    const mk = (verb, to, testid) => {
      const b = h("button", { type: "button", class: "mem-btn", "data-testid": testid, "aria-disabled": blocked ? "true" : "false", disabled: blocked, onClick: (ev) => !blocked && openBatch(batch, to, ev.currentTarget) }, batchButtonWords(batch, verb));
      return b;
    };
    return h("div", { class: "mem-batch", "data-testid": "mem-batch", "data-source": batch.source }, h("span", { class: "mem-muted" }, batch.source + " · " + batch.size + " cards"), mk("Approve", "approved", "mem-batch-approve"), mk("Reject", "rejected", "mem-batch-reject"));
  }

  function paint() {
    const focused = host.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement.closest("[data-card]") : null;
    const focusId = focused ? focused.getAttribute("data-card") : null;
    if (phase === "loading") body.replaceChildren(h("p", { class: "mem-muted", role: "status", "data-testid": "mem-queue-state" }, COPY.loading));
    else if (phase === "error") body.replaceChildren(h("p", { class: "mem-error", role: "alert", "data-testid": "mem-queue-state" }, COPY.unavailable), h("button", { type: "button", class: "mem-btn", "data-testid": "mem-queue-retry", onClick: () => reload(null) }, COPY.retry));
    else if (cards.length === 0) body.replaceChildren(h("p", { class: "mem-muted", "data-testid": "mem-queue-state" }, COPY.emptyQueue));
    else {
      body.replaceChildren(
        ...scopesOfCards(cards).map((scope) => {
          const place = places.get(scope.scope + "|" + scope.label) || null;
          const n = countFor(place, scope.cards);
          return h(
            "section",
            { class: "mem-scope", "aria-label": scope.label, "data-testid": "mem-queue-scope" },
            h("h3", { class: "mem-h3" }, h("bdi", null, scope.label), " ", h("span", { class: "mem-badge", "data-testid": "mem-badge", "data-count": n === null ? "" : String(n) }, waitingWords(n))),
            batchesOf(scope.cards).map((batch) => [batchBar(batch), h("div", { class: "mem-cards" }, batch.cards.map(cardNode))])
          );
        }),
        ...(truncated ? [h("p", { class: "mem-muted" }, "More proposals are waiting than this shows. Decide these and the rest appear.")] : [])
      );
    }
    if (focusId) {
      const el = cardEl(focusId);
      if (el && host.ownerDocument.activeElement !== el && !host.contains(host.ownerDocument.activeElement)) el.focus();
    }
  }

  return {
    set({ cards: c, truncated: t, phase: p, places: pl }) {
      cards = c;
      truncated = t;
      phase = p;
      places = pl;
      paint();
    },
    focus(id) {
      const el = id ? cardEl(id) : null;
      (el || heading).focus();
    },
    destroy() {
      if (dialog) {
        dialog.dlg.close();
        dialog.dlg.remove();
        dialog = null;
      }
      host.replaceChildren();
    },
  };
}
