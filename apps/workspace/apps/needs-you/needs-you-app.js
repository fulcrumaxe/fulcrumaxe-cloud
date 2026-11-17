// D#598 P8c: the Needs you app. One list of the steps people must do for the platform; today each row is a setup request (P8a and P8b).
//
// The page draws what needs-you-model.js reads. Every node is built with h(), so text from an agent (a request's title, reason and status sentence)
// is a text node and never markup. Controls use aria-disabled, not disabled, so a pressed control keeps focus while its request is in flight and a
// second press is ignored. When a row changes under the person, focus goes to the same control, else to the row's heading.
import { h } from "../_lib/dom.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { ANSWER_WORDS, CHOICE_LABELS, WORDS, answerable, canMarkDone, choicesFor, lockReason, sentIsFinal, stateWords, confirmWords, createNeedsYou, engineWords, isBranchRow, notShownWords, nowAtWords, waitingHolderWords } from "./needs-you-model.js";

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

  // A control of the "someone pushed to the branch" request: same shape as the others, its own action.
  const branchButton = (row, act, label, run) => {
    const working = list.busyVerb(row.id);
    return h(
      "button",
      { type: "button", class: "ny-btn", "data-testid": "ny-" + act + "-" + row.id, "data-act": act, "aria-disabled": working ? "true" : "false", "aria-label": label + ": " + row.title, onClick: () => { if (!list.busyVerb(row.id)) run(); } },
      label
    );
  };

  // The managed line and the choices of a "someone pushed" request. Replace asks twice: the second question names the head it is about, and only its button sends.
  function branchBlock(row) {
    // After an answer one control stays: the undo of Keep, or Keep itself while a Replace waits for its update (Keep wins until a round has taken the head; one already under way can still land first, and then the managed line says so).
    if (row.state !== "open") return row.branchManaged ? h("div", { class: "ny-actions" }, branchButton(row, "release", WORDS.release, () => list.release(row.id))) : row.replacePending ? h("div", { class: "ny-actions" }, branchButton(row, "keep", WORDS.keep, () => list.keep(row.id))) : null;
    const head = nowAtWords(row.seenHead);
    const asking = list.confirmingHead(row.id) !== "";
    return h(
      "div",
      { class: "ny-branch" },
      head ? h("p", { class: "ny-sentence", "data-testid": "ny-head" }, head) : null,
      asking ? h("p", { class: "ny-sentence", role: "group", "aria-label": WORDS.replace, "data-testid": "ny-confirm" }, confirmWords(list.confirmingHead(row.id))) : null,
      h(
        "div",
        { class: "ny-actions" },
        asking
          ? [branchButton(row, "replace-yes", WORDS.replaceYes, () => list.replace(row.id)), branchButton(row, "replace-cancel", WORDS.cancel, () => list.cancelReplace(row.id))]
          : [branchButton(row, "keep", WORDS.keep, () => list.keep(row.id)), row.seenHead !== "" ? branchButton(row, "replace", WORDS.replace, () => list.askReplace(row.id)) : null, button(row, "withdraw", WORDS.withdraw)]
      )
    );
  }

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
      row.overdue ? h("p", { class: "ny-state", "data-testid": "ny-overdue" }, WORDS.overdue) : null,
      row.due ? h("p", { class: "ny-due", "data-testid": "ny-due" }, row.due) : null,
      row.proposedLabel ? h("p", { class: "ny-proposed", "data-testid": "ny-proposed" }, WORDS.recommended + ": " + row.proposedLabel) : null,
      // The agent's reason is a quotation: a text node inside a blockquote, never markup and never an instruction.
      row.reason ? h("blockquote", { class: "ny-quote", "data-testid": "ny-reason" }, row.reason) : null,
      row.timeout ? h("p", { class: "ny-sentence", "data-testid": "ny-timeout" }, row.timeout) : null,
      // Only an owner or admin sees the buttons (the server stays the judge); anyone else is told whose answer it waits for. A member-plan ask waits for its plan holder alone.
      row.planHolder && !row.planHolder.isYou
        ? h("p", { class: "ny-sentence", "data-testid": "ny-waiting" }, waitingHolderWords(row.planHolder.name))
        : list.state.isAdmin
        ? h("div", { class: "ny-actions" }, row.options.map((o) => choiceButton(row, o.id, o.label, o.id === row.proposed)).concat(choiceButton(row, "deny", WORDS.deny, false)))
        : h("p", { class: "ny-sentence", "data-testid": "ny-waiting" }, WORDS.waitingAdmin)
    );
  }

  // A work item that needs a person and is not on the stalled list: the fixed sentence and one plain navigation to its card.
  function personView(row) {
    const headId = "ny-h-" + row.id;
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "person", "data-id": row.id, "data-state": row.state },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, row.sentence),
      h("div", { class: "ny-actions" }, h("button", { type: "button", class: "ny-btn", "data-testid": "ny-open-" + row.id, "data-act": "open", "aria-label": WORDS.open + ": " + row.title, onClick: () => window.FULCWM && window.FULCWM.open("pipeline", { workItemId: row.workItemId }) }, WORDS.open))
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

  // D#749: the checking account's sign-in on a runner needs renewing: the cloud's fixed sentence and the one command to run, as text. No button: the person signs in on the runner's machine,
  // and the row leaves on the next read once the runner reports a fresh sign-in.
  function signInView(row) {
    const headId = "ny-h-" + row.id;
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "signin", "data-id": row.id, "data-state": row.state },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, row.sentence),
      h("p", null, h("code", { class: "ny-command", "data-testid": "ny-command" }, row.command))
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

  // EB-13b: the answer controls of an engine ask. An owner or admin sees Approve, Decline and (except for a decision) Defer, and an optional one-line note. They are never
  // `disabled`: a locked or busy control is aria-disabled with its reason in view and named by aria-describedby, so it keeps focus and a second press is ignored. The note
  // field keeps its text across redraws (the model holds it), and the count beside it is updated by the field's own input event, with no announcement per keystroke.
  function answerView(row, headId) {
    if (!answerable(row)) return null;
    // A decision ask is never hidden from a member: its controls are shown locked, with the reason beside them (the server still refuses a member with 403).
    const memberLock = !list.state.isAdmin && row.decisionId !== "";
    if (!list.state.isAdmin && !memberLock) return row.operateEnabled ? h("p", { class: "ny-sentence", "data-testid": "ny-waiting" }, ANSWER_WORDS.waitingAdmin) : null;
    const lock = memberLock ? ANSWER_WORDS.lockMember : lockReason(row);
    const sent = list.engineSent(row.id);
    const working = list.busyVerb(row.id) !== "";
    // An ask whose waiting answers could not be checked is locked like a closed one: a second answer might otherwise follow one the engine has not shown yet.
    const unchecked = sent === null && list.engineUnchecked(row.id);
    const still = lock !== "" || unchecked || working || (sent !== null && sentIsFinal(sent));
    const lockId = "ny-lock-" + row.id;
    const uncheckedId = "ny-unchecked-" + row.id;
    const noteId = "ny-note-" + row.id;
    const hintId = "ny-hint-" + row.id;
    const countId = "ny-count-" + row.id;
    const withNote = row.decisionId === "";
    const count = h("span", { id: countId, class: "ny-count", "data-testid": "ny-count" }, ANSWER_WORDS.count(list.noteOf(row.id).length));
    const field = withNote
      ? h(
          "div",
          { class: "ny-note-field" },
          h("label", { class: "ny-note-label", for: noteId }, ANSWER_WORDS.note),
          h("input", {
            id: noteId,
            type: "text",
            class: "ny-note",
            autocomplete: "off",
            value: list.noteOf(row.id),
            readonly: still,
            "aria-disabled": still ? "true" : "false",
            "aria-describedby": hintId + " " + countId,
            "data-act": "note",
            "data-testid": "ny-note-" + row.id,
            onInput: (ev) => {
              list.setNote(row.id, ev.target.value);
              count.textContent = ANSWER_WORDS.count(ev.target.value.length);
            },
          }),
          h("span", { id: hintId, class: "ny-muted" }, ANSWER_WORDS.noteHint),
          count
        )
      : null;
    const choiceBtn = (choice) =>
      h(
        "button",
        {
          type: "button",
          class: "ny-btn",
          "data-testid": "ny-choice-" + row.id + "-" + choice,
          "data-act": "choice-" + choice,
          "aria-disabled": still ? "true" : "false",
          "aria-label": CHOICE_LABELS[choice] + ": " + row.title,
          "aria-describedby": lock !== "" ? lockId : unchecked ? uncheckedId : null,
          onClick: () => {
            if (list.busyVerb(row.id) === "") list.answerEngine(row.id, choice);
          },
        },
        CHOICE_LABELS[choice]
      );
    const again = sent !== null && !sentIsFinal(sent);
    return h(
      "div",
      { class: "ny-answer", role: "group", "aria-labelledby": headId, "data-testid": "ny-answer" },
      lock !== "" ? h("p", { id: lockId, class: "ny-warn", "data-testid": "ny-lock" }, lock) : null,
      row.halted ? h("p", { class: "ny-muted", "data-testid": "ny-halted" }, ANSWER_WORDS.halted) : null,
      unchecked ? h("p", { id: uncheckedId, class: "ny-warn", "data-testid": "ny-unchecked" }, ANSWER_WORDS.cantCheck) : null,
      sent !== null ? h("p", { class: again ? "ny-warn" : "ny-sentence", "data-testid": "ny-sent", "data-state": sent.state }, stateWords(sent)) : null,
      // The note that was sent is shown back as text, in a quotation: a text node, never markup.
      sent !== null && sent.note !== "" ? h("p", { class: "ny-reason", "data-testid": "ny-note-sent" }, ANSWER_WORDS.noteSent + ": ", h("q", null, sent.note)) : null,
      field,
      h(
        "div",
        { class: "ny-actions" },
        choicesFor(row).map(choiceBtn),
        unchecked
          ? h("button", { type: "button", class: "ny-btn", "data-testid": "ny-recheck-" + row.id, "data-act": "recheck", "aria-disabled": working ? "true" : "false", "aria-label": ANSWER_WORDS.tryAgain + ": " + row.title, onClick: () => { if (list.busyVerb(row.id) === "") list.recheck(row.id); } }, ANSWER_WORDS.tryAgain)
          : null,
        again
          ? h("button", { type: "button", class: "ny-btn", "data-testid": "ny-again-" + row.id, "data-act": "again", "aria-disabled": still ? "true" : "false", "aria-label": ANSWER_WORDS.sendAgain + ": " + row.title, onClick: () => list.sendAgain(row.id) }, ANSWER_WORDS.sendAgain)
          : null
      )
    );
  }

  // EB-6c: an open ask of the engine (EB-13b adds the answer controls). The repo's name is untrusted text and goes in <bdi>; the D# and PR # links are built from it by the model.
  // The sentences about age are worked out here, at draw time, so they stay true between reads. Each link keeps its data-act so focus returns to it after a redraw.
  function engineView(row) {
    const headId = "ny-h-" + row.id;
    const w = engineWords(row, Date.now());
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "engine", "data-id": row.id, "data-state": row.state },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, h("bdi", null, row.title)),
      h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, row.sentence),
      row.links.length > 0
        ? h("p", { class: "ny-refs", "data-testid": "ny-refs" }, row.links.map((l, i) => h("a", { class: "ny-link", href: l.href, target: "_blank", rel: "noopener noreferrer", "aria-describedby": headId, "data-act": "link-" + i, "data-testid": "ny-engine-link-" + i }, l.text, h("span", { class: "ny-sr", "data-testid": "ny-engine-link-hint-" + i }, " (opens in a new tab)"))))
        : null,
      h("p", { "data-testid": "ny-raised" }, w.raised),
      w.stale ? h("p", { class: "ny-warn", "data-testid": "ny-stale" }, w.stale) : null,
      w.machine ? h("p", { class: "ny-warn", "data-testid": "ny-machine" }, w.machine) : null,
      w.source ? h("p", { class: "ny-warn", "data-testid": "ny-source" }, w.source) : null,
      h("p", { class: "ny-muted", "data-testid": "ny-asof" }, w.asOf),
      answerView(row, headId)
    );
  }

  function rowView(row) {
    if (row.kind === "engine") return engineView(row);
    if (row.kind === "stalled") return stalledView(row);
    if (row.kind === "ask") return askView(row);
    if (row.kind === "person") return personView(row);
    if (row.kind === "merge") return mergeView(row);
    if (row.kind === "signin") return signInView(row);
    const working = list.busyVerb(row.id);
    const headId = "ny-h-" + row.id;
    // While Mark done is in flight on a request with an automatic check, the approved "Checking now." stands in for the answer.
    const sentence = working === "done" && row.hasCheck ? WORDS.checkingNow : row.sentence;
    return h(
      "li",
      { class: "ny-row", "data-testid": "ny-row", "data-kind": "setup", "data-id": row.id, "data-state": row.state, "aria-busy": working ? "true" : "false" },
      h("h3", { id: headId, class: "ny-row-title", tabindex: "-1", "data-testid": "ny-title" }, row.title),
      row.state === "open" || (isBranchRow(row) && (row.branchManaged || row.replacePending)) ? null : h("p", { class: "ny-state", "data-testid": "ny-state" }, row.state === "done" ? WORDS.done : WORDS.withdrawn),
      row.reason ? h("p", { class: "ny-reason", "data-testid": "ny-reason" }, row.reason) : null,
      sentence ? h("p", { class: "ny-sentence", "data-testid": "ny-sentence" }, sentence) : null,
      row.link ? h("p", null, h("a", { class: "ny-link", href: row.link.href, target: "_blank", rel: "noopener noreferrer", "aria-describedby": headId, "data-testid": "ny-link" }, row.link.host)) : null,
      isBranchRow(row)
        ? branchBlock(row)
        : row.state === "open" ? h("div", { class: "ny-actions" }, canMarkDone(row) ? button(row, "done", WORDS.markDone) : null, button(row, "withdraw", WORDS.withdraw)) : null
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
    // The caret of a field being typed in survives the redraw with the field's text (the model holds the text).
    const caret = held && held.tagName === "INPUT" && typeof held.selectionStart === "number" ? [held.selectionStart, held.selectionEnd] : null;
    const openCount = s.rows.filter((r) => r.state === "open").length;
    const body =
      s.status === "loading" ? h("p", { class: "ny-muted", role: "status", "data-testid": "ny-loading" }, WORDS.loading)
      : s.status === "error" ? h("p", { class: "ny-error", role: "alert", "data-testid": "ny-error" }, WORDS.error)
      : s.rows.length === 0 ? (s.engineFailed ? null : h("p", { class: "ny-muted", "data-testid": "ny-empty" }, WORDS.empty)) // "nothing needs you" would be false while the engine's asks are unread
      : h("ul", { class: "ny-rows", role: "list", "data-testid": "ny-rows" }, s.rows.map(rowView));
    setText(heading, WORDS.title + (s.status === "ready" ? " (" + openCount + ")" : ""));
    const focusId = s.focusId;
    if (s.announce !== "") {
      live.textContent = s.announce;
      list.clearAnnounce(); // said once; a later draw does not say it again
    } else if (list.anyBusy()) {
      live.textContent = ""; // a new action starts: the same sentence can be said again when it ends
    }
    setText(alertEl, s.error);
    content.replaceChildren(...(body ? [body] : []));
    // EB-6c: one plain line, not an alert (it is spoken once, through the live region, when it first appears); the other rows stay.
    if (s.status === "ready" && s.engineFailed) content.appendChild(h("p", { class: "ny-warn", "data-testid": "ny-engine-error" }, WORDS.engineError));
    if (s.status === "ready" && s.engineMore) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-more-engine" }, WORDS.moreEngine));
    if (s.status === "ready" && s.notShown > 0) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-not-shown" }, notShownWords(s.notShown)));
    if (s.status === "ready" && s.moreAsks) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-more-asks" }, WORDS.moreAsks));
    if (s.status === "ready" && s.moreItems) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-more-items" }, WORDS.moreItems));
    if (s.status === "ready" && s.truncated) content.appendChild(h("p", { class: "ny-muted", "data-testid": "ny-older" }, WORDS.older));
    if (s.focusAct) {
      // A choice that swaps the buttons (Replace asks, Cancel goes back): focus goes to the control that now answers it.
      const row = [...content.querySelectorAll("[data-id]")].find((r) => r.getAttribute("data-id") === s.focusAct.id);
      const target = row ? [...row.querySelectorAll("[data-act]")].find((b) => b.getAttribute("data-act") === s.focusAct.act) : null;
      (target || (row && row.querySelector("h3")) || heading).focus();
      list.clearAnnounce();
    } else if (focusId !== null) {
      // An answered ask left the list: focus goes to the next row's heading, or to the list heading when there is none.
      const next = [...content.querySelectorAll("[data-id]")].find((r) => r.getAttribute("data-id") === focusId);
      (next ? next.querySelector("h3") : heading).focus();
    } else if (heldKey) {
      const row = [...content.querySelectorAll("[data-id]")].find((r) => r.getAttribute("data-id") === heldKey[0]);
      const again = row && heldKey[1] ? [...row.querySelectorAll("[data-act]")].find((b) => b.getAttribute("data-act") === heldKey[1]) : null;
      (again || (row && row.querySelector("h3")) || heading).focus();
      if (again && caret && again.tagName === "INPUT") again.setSelectionRange(caret[0], caret[1]);
    }
  }

  paint();
  list.load();
  list.start({ subscribe: onRefresh, listen: on, hidden: () => document.hidden });
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
