// D#3 K07b-2: the Site review app: one site version's review report, read-only
// for members; attest, carry-forward and approve for owners and admins. Nodes
// are built with h() (server text renders as text). A picker lists the account's
// sites (GET /api/v1/sites) and each site's versions; the newest version still
// awaiting approval is preselected, and the last choice is remembered as Roles does.
// "Open by id" stays as a labelled fallback for support.
// Pending links start unticked; every failed write shows one fixed sentence and
// re-reads the report. The admin flag only hides controls; the server decides.
import { h } from "../_lib/dom.js";
import { api, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { onRefresh } from "../../core/cloud-live.js";
import { getItem, setItem } from "../../core/storage-ns.js";
import { buildApproveBody, canApprove, pickAcross, pickDefault, refusedSentence, siteLabels, versionText } from "./site-review-logic.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Site review app: the FULC SDK global is missing");
}

const ID_KEY = "site-review:version";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = "The review isn't available right now.";
const NOT_FOUND = "That site version wasn't found.";
const BAD_ID = "Enter a site version id (a UUID).";
const SITES_UNAVAILABLE = "Your sites aren't available right now.";
const VERSIONS_UNAVAILABLE = "This site's versions aren't available right now.";
const NO_SITES = "No sites yet. A site appears here once the site kit has built one for you.";
const NO_VERSIONS = "This site has no versions to review yet.";
const PREFETCH_SITES = 10;
const NOT_ALLOWED = "Only owners and admins can do that.";
const FAILED = "That didn't go through. Try again.";
const TERMS = "I am the publisher of this site. I have read it and I accept responsibility for what it says.";
const REFUSED = {
  already_approved: "This version is already approved.",
  unapproved_link: "Some outbound links still need your approval.",
  terms_not_accepted: "Accept the terms before approving.",
  unattested_claim: "A legal, pricing or security claim still needs attestation.",
  render_failed: "The site could not be rendered, so it can't be approved yet.",
  blocked: "The site still has blocking claims.",
  leak: "The rendered site contains something that must not be published.",
  check_failed: "The site didn't pass every check, so it can't be approved yet.",
  browser_driver_missing: "Approval can't finish until the browser checks can run in production.",
  claim_not_in_site: "That claim doesn't belong to this site.",
  not_attestable: "Only legal, pricing and security claims can be attested.",
};

// A read that failed: the wait for a 429, otherwise one fixed sentence. Server text is never shown.
function listFailure(e, fallback) {
  if (isRateLimited(e)) return "Too many tries. " + retryWords(waitSeconds(e));
  if (e && e.status === 404) return "That site wasn't found.";
  return fallback;
}

function failure(e) {
  if (e && e.status === 403) return NOT_ALLOWED;
  if (e && e.status === 404) return NOT_FOUND;
  if (e && e.status === 409) return refusedSentence(REFUSED, e.code, FAILED);
  return FAILED;
}

// Cosmetic: the server's 403 stays authoritative.
async function loadIsAdmin(signal) {
  try {
    const me = await api("GET", "/api/cloud/auth/me", undefined, signal);
    return !!(me && me.is_admin);
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return false;
  }
}

function mountApp(contentEl, launchArg) {
  let versionId = "";
  let review = null;
  let isAdmin = null;
  let note = "";
  let terms = false;
  let ticked = new Set();
  let busy = false;
  let closed = false;
  let seq = 0;
  let ctl = null;
  // The picker: the sites read, each site's versions, and the site shown as selected.
  const sites = { status: "loading", rows: [], next: null, err: "" };
  const versions = new Map();
  let selSite = "";
  let sitesSeq = 0;

  const status = h("p", { class: "sr-status", role: "status", "aria-live": "polite", "data-testid": "sr-status" });
  const input = h("input", {
    class: "sr-input",
    id: "sr-version-id",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    "data-testid": "sr-id",
    onKeydown: (ev) => ev.key === "Enter" && choose(input.value.trim()),
  });
  const openBtn = h("button", { class: "sr-btn", type: "button", "data-testid": "sr-open", onClick: () => choose(input.value.trim()) }, "Open");
  const byId = h(
    "details",
    { class: "sr-byid", "data-testid": "sr-byid" },
    h("summary", null, "Open by id (for support)"),
    h("label", { class: "sr-label", for: "sr-version-id" }, "Site version id"),
    h("div", { class: "sr-open" }, input, openBtn)
  );
  const picker = h("div", { class: "sr-picker", "data-testid": "sr-picker" });
  const body = h("div", { "data-testid": "sr-body" });
  // D#3 K09b: the Site kit plan panel is its own module, loaded on the first report that names a site.
  const planHost = h("div", { class: "sr-plan", "data-testid": "sr-plan" });
  let plan = null;
  let planLoad = null;
  contentEl.replaceChildren(
    h("div", { class: "sr-app" }, h("h2", { class: "sr-title" }, "Site review"), picker, byId, status, body)
  );

  const button = (key, label, onClick, disabled) =>
    h("button", { class: "sr-btn", type: "button", disabled, "data-key": key, "data-testid": key, onClick }, label);
  const check = (key, label, checked, onChange) =>
    h("label", { class: "sr-link" }, h("input", { type: "checkbox", checked, "data-key": key, "data-testid": key, onChange }), " ", label);

  // ── the picker ──────────────────────────────────────────────────────────────
  const siteEntry = (id) => versions.get(id) || { status: "loading", rows: [], next: null, err: "" };

  function renderPicker() {
    if (closed) return;
    const at = document.activeElement;
    const held = at && picker.contains(at) ? at.getAttribute("data-testid") : null;
    const kids = [];
    if (sites.status === "loading") {
      kids.push(h("p", { "data-testid": "sr-picker-loading" }, "Loading your sites..."));
    } else if (sites.status === "error") {
      kids.push(h("p", { role: "alert", "data-testid": "sr-picker-error" }, sites.err), button("sr-picker-retry", "Try again", () => loadSites(false)));
    } else if (!sites.rows.length) {
      kids.push(h("p", { "data-testid": "sr-empty" }, NO_SITES));
    } else {
      // A site opened by id or from memory may be past the first page of sites: it is still shown, by a short id.
      const rows = selSite && !sites.rows.some((s) => s.id === selSite) ? [...sites.rows, { id: selSite }] : sites.rows;
      const labels = siteLabels(rows);
      const siteSel = h(
        "select",
        { class: "sr-input", id: "sr-site-select", "data-testid": "sr-site", onChange: (ev) => pickSite(ev.target.value) },
        rows.map((s, i) => h("option", { value: s.id }, labels[i]))
      );
      if (selSite) siteSel.value = selSite;
      kids.push(h("label", { class: "sr-label", for: "sr-site-select" }, "Site"), siteSel);
      if (sites.next) kids.push(button("sr-more-sites", "Show more sites", () => loadSites(true)));
      if (selSite) kids.push(...versionPicker(siteEntry(selSite)));
    }
    picker.replaceChildren(...kids);
    if (held) {
      const again = Array.from(picker.querySelectorAll("[data-testid]")).find((n) => n.getAttribute("data-testid") === held);
      if (again) again.focus();
    }
  }

  function versionPicker(entry) {
    if (entry.status === "error" && !entry.rows.length) {
      return [h("p", { role: "alert", "data-testid": "sr-versions-error" }, entry.err), button("sr-versions-retry", "Try again", () => loadVersions(selSite, false))];
    }
    if (entry.status === "loading" && !entry.rows.length) return [h("p", { "data-testid": "sr-versions-loading" }, "Loading versions...")];
    if (!entry.rows.length) return [h("p", { "data-testid": "sr-no-versions" }, NO_VERSIONS)];
    const known = entry.rows.some((v) => v.version_id === versionId);
    const opts = entry.rows.map((v) => h("option", { value: v.version_id }, versionText(v)));
    // A version opened by id may be past the first page of versions: it is still named, by a short id.
    if (versionId && !known) opts.push(h("option", { value: versionId }, "Version " + versionId.slice(0, 8)));
    if (!versionId) opts.unshift(h("option", { value: "" }, "Choose a version"));
    const sel = h("select", { class: "sr-input", id: "sr-version-select", "data-testid": "sr-version", onChange: (ev) => ev.target.value && choose(ev.target.value) }, opts);
    sel.value = versionId;
    return [
      h("label", { class: "sr-label", for: "sr-version-select" }, "Version"),
      sel,
      entry.next ? button("sr-more-versions", "Show more versions", () => loadVersions(selSite, true)) : null,
      entry.status === "error" ? h("p", { role: "alert", "data-testid": "sr-versions-error" }, entry.err) : null,
    ].filter(Boolean);
  }

  async function loadSites(more) {
    const mine = ++sitesSeq;
    if (!more) {
      sites.status = "loading";
      renderPicker();
    }
    try {
      const page = await api("GET", "/api/v1/sites?limit=50" + (more && sites.next ? "&cursor=" + encodeURIComponent(sites.next) : ""));
      if (closed || mine !== sitesSeq) return;
      sites.rows = more ? [...sites.rows, ...page.data] : page.data;
      sites.next = page.next_cursor || null;
      sites.status = "ready";
    } catch (e) {
      if (closed || mine !== sitesSeq) return;
      sites.err = listFailure(e, SITES_UNAVAILABLE);
      if (more) {
        note = sites.err;
        return render();
      }
      sites.status = "error";
      return renderPicker();
    }
    if (!more) {
      await Promise.all(sites.rows.slice(0, PREFETCH_SITES).map((s) => loadVersions(s.id, false, true)));
      if (closed || mine !== sitesSeq) return;
      // Nothing chosen yet (no launch argument, nothing remembered): the newest version awaiting approval.
      if (!versionId) {
        const best = pickAcross(sites.rows.filter((s) => versions.has(s.id)).map((s) => ({ siteId: s.id, rows: siteEntry(s.id).rows })));
        if (best) {
          selSite = best.siteId;
          return choose(best.version.version_id);
        }
      }
      if (!selSite && sites.rows.length) selSite = sites.rows[0].id;
    }
    renderPicker();
  }

  // One site's versions. `more` reads the next page; `quiet` keeps the list on screen while it is read again.
  async function loadVersions(siteId, more, quiet) {
    const prev = versions.get(siteId);
    const entry = more && prev ? prev : { status: "loading", rows: quiet && prev ? prev.rows : [], next: null, err: "" };
    const cursor = more && prev && prev.next ? "&cursor=" + encodeURIComponent(prev.next) : "";
    versions.set(siteId, { ...entry, status: "loading" });
    if (!quiet) renderPicker();
    try {
      const page = await api("GET", "/api/v1/sites/" + siteId + "/versions?limit=50" + cursor);
      versions.set(siteId, { status: "ready", rows: more && prev ? [...prev.rows, ...page.data] : page.data, next: page.next_cursor || null, err: "" });
    } catch (e) {
      versions.set(siteId, { ...entry, status: "error", err: listFailure(e, VERSIONS_UNAVAILABLE) });
    }
    if (!closed) renderPicker();
  }

  async function pickSite(id) {
    if (busy || !id) return;
    selSite = id;
    if (!versions.has(id) || versions.get(id).status === "error") await loadVersions(id, false);
    else renderPicker();
    if (closed || selSite !== id) return;
    const first = pickDefault(siteEntry(id).rows);
    if (first) return choose(first.version_id);
    // A site with no versions: nothing is open.
    versionId = "";
    review = null;
    note = "";
    input.value = "";
    render();
    renderPicker();
  }

  function view() {
    const { report, claims, pending_links: links } = review;
    const canAct = isAdmin === true && !review.approved;
    const ready = canApprove(review, ticked, terms);
    const head = (text) => h("h3", { class: "sr-heading" }, text);
    return [
      h("h3", { class: "sr-heading", tabindex: -1, "data-key": "heading", "data-testid": "sr-heading" }, review.approved ? "Approved" : "Awaiting approval"),
      isAdmin === false ? h("p", { "data-testid": "sr-readonly" }, "You can read this report. Only owners and admins can attest or approve.") : null,
      head("Claims by verdict"),
      h("ul", { class: "sr-list", "data-testid": "sr-counts" }, Object.entries(report.counts).map(([v, n]) => h("li", null, v + ": " + n))),
      head("Blockers"),
      h("ul", { class: "sr-list", "data-testid": "sr-blockers" }, report.blockers.length ? report.blockers.map((b) => h("li", null, b.source + ": " + b.reason + " - " + b.detail)) : h("li", null, "None")),
      head("Evidence"),
      h("ul", { class: "sr-list", "data-testid": "sr-evidence" }, report.evidence.map((e) => h("li", null, e.text))),
      head("Legal, pricing and security claims"),
      canAct && claims.some((c) => !c.attested) ? button("sr-carry", "Carry earlier attestations forward", () => act("sr-carry", { carry_forward: true }, "attest")) : null,
      h(
        "div",
        { "data-testid": "sr-claims" },
        claims.map((c) =>
          h(
            "div",
            { class: "sr-claim", "data-testid": "sr-claim" },
            h("span", null, c.kind + " (" + c.locale + "): " + (c.text || c.claim_key)),
            c.attested
              ? h("span", null, "Attested")
              : canAct
                ? button("sr-attest-" + c.claim_id, "Attest", () => act("sr-attest-" + c.claim_id, { claim_id: c.claim_id }, "attest"))
                : h("span", null, "Not attested")
          )
        )
      ),
      head("Outbound links"),
      links.length ? h("div", { "data-testid": "sr-links" }, links.map((l) => (canAct ? check("sr-link-" + l, l, ticked.has(l), (ev) => tick(l, ev.target.checked)) : h("span", { class: "sr-link" }, l)))) : h("p", null, "None"),
      canAct ? check("sr-terms", TERMS, terms, (ev) => { terms = ev.target.checked; render("sr-terms"); }) : null,
      canAct ? button("sr-approve", "Approve and publish", () => act("sr-approve", buildApproveBody(links, ticked), "approve"), !ready) : null,
    ];
  }

  function tick(link, on) {
    if (on) ticked.add(link);
    else ticked.delete(link);
    render("sr-link-" + link);
  }

  function render(focusKey) {
    if (closed) return;
    status.textContent = note;
    // A refresh names no control: the one that has focus keeps it, as in Roles.
    const at = document.activeElement;
    const held = at && body.contains(at) ? at.getAttribute("data-key") : null;
    focusKey = focusKey || held;
    body.replaceChildren(...(review ? view().filter(Boolean) : []));
    if (review && UUID.test(review.site_id || "")) body.append(planHost);
    // Focus stays on the control that was used; if it is gone, it goes to the heading.
    const keyed = (k) => Array.from(body.querySelectorAll("[data-key]")).find((n) => n.getAttribute("data-key") === k);
    const el = review && focusKey && (keyed(focusKey) || keyed("heading"));
    if (el) el.focus();
  }

  async function load(focusKey, keepNote) {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const mine = ++seq;
    try {
      const [next, admin] = await Promise.all([
        api("GET", "/api/v1/site-versions/" + versionId + "/review", undefined, ctl.signal),
        isAdmin === null ? loadIsAdmin(ctl.signal) : isAdmin,
      ]);
      if (mine !== seq) return;
      review = next;
      isAdmin = admin;
      if (UUID.test(next.site_id || "") && selSite !== next.site_id) {
        selSite = next.site_id;
        if (!versions.has(selSite)) loadVersions(selSite, false);
      }
      ticked = new Set([...ticked].filter((l) => next.pending_links.includes(l)));
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      review = null;
      const why = e && e.status === 404 ? NOT_FOUND : UNAVAILABLE;
      // A remembered id that no longer exists is forgotten, so the next open falls back to the picker's default.
      if (e && e.status === 404 && getItem(ID_KEY) === versionId) setItem(ID_KEY, "");
      // After a write, its result sentence stays; the failed re-read is added beside it.
      note = keepNote && note ? note + " " + why : why;
    }
    render(focusKey);
    renderPicker();
    showPlan();
  }

  async function showPlan() {
    if (!review || !UUID.test(review.site_id || "")) return;
    planLoad = planLoad || import("./site-review-plan.js").then((m) => m.mountPlan(planHost), () => null);
    plan = await planLoad;
    if (plan && !closed && review) plan.show(review.site_id, isAdmin === true);
  }

  function choose(id) {
    if (busy) return;
    if (!UUID.test(id)) {
      note = BAD_ID;
      review = null;
      return render();
    }
    versionId = id;
    input.value = id;
    const known = Array.from(versions.entries()).find(([, v]) => v.rows.some((r) => r.version_id === id));
    if (known) selSite = known[0];
    setItem(ID_KEY, id);
    review = null;
    ticked = new Set();
    terms = false;
    note = "";
    render();
    load();
  }

  // One write. Success or failure, the report is read again and redrawn.
  async function act(key, payload, kind) {
    if (busy) return;
    busy = true;
    note = "";
    try {
      await api("POST", "/api/v1/site-versions/" + versionId + "/" + kind, payload);
      note = kind === "approve" ? "Approved. Publishing is a separate step." : "Attestation saved.";
    } catch (e) {
      note = failure(e);
    }
    busy = false;
    await load(key, true);
    if (selSite) loadVersions(selSite, false, true);
  }

  const off = onRefresh(() => {
    if (!busy && versionId) load();
    if (!busy && selSite && sites.status === "ready") loadVersions(selSite, false, true);
  });
  // Another app may open this one with {versionId}. It is untrusted: only a string
  // that is a UUID is used; anything else is ignored and the remembered id applies.
  const asked = launchArg && typeof launchArg.versionId === "string" ? launchArg.versionId : "";
  const saved = getItem(ID_KEY);
  if (UUID.test(asked)) choose(asked);
  else if (saved && UUID.test(saved)) choose(saved);
  renderPicker();
  loadSites(false).then(() => {
    // Nothing to pick from: the fallback is the way in, so it starts open.
    if (!closed && (sites.status === "error" || !sites.rows.length)) byId.open = true;
  });

  return {
    destroy() {
      closed = true;
      if (plan) plan.destroy();
      off();
      seq++;
      if (ctl) ctl.abort();
      contentEl.replaceChildren();
    },
  };
}

let current = null;

FULC.register({
  id: "site-review",
  title: "Site review",
  icon: "S",
  defaultSize: { w: 820, h: 620 },
  onOpen({ contentEl, launchArg }) {
    if (current) current.destroy();
    current = mountApp(contentEl, launchArg);
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
