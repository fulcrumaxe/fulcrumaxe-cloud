// Approve sends exactly the links the user ticked, never the pending list.
export function buildApproveBody(pendingLinks, ticked) {
  return { terms_accepted: true, approved_links: pendingLinks.filter((l) => ticked.has(l)) };
}

// D#3 K07b-2 (TL ruling): only what the user can settle disables Approve. The
// stored `gates` and `links` blockers and the report's `ok` do not: approve
// re-runs both on the server and a refusal comes back as a 409.
export function canApprove(review, ticked, terms) {
  const { report, claims, pending_links: links, approved } = review;
  return (
    !approved &&
    terms &&
    claims.every((c) => c.attested) &&
    links.every((l) => ticked.has(l)) &&
    !report.blockers.some((b) => b.source === "gateSite" || b.source === "leak")
  );
}

// A 409 code maps to a fixed sentence only if the table owns it: "constructor" and the like fall back.
export function refusedSentence(table, code, fallback) {
  return Object.hasOwn(table, code) ? table[code] : fallback;
}

// D#3 (picker): labels and the default choice for the site and version lists. Everything here returns plain
// text; a missing field never becomes "null" or "undefined" on screen.
const STATE_TEXT = { pending: "Awaiting approval", approved: "Approved", published: "Published" };

export function stateText(state) {
  return Object.hasOwn(STATE_TEXT, state) ? STATE_TEXT[state] : "Unknown state";
}

const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// "2026-09-18 12:00 UTC", or a fixed phrase when the date cannot be read.
export function dayText(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Unknown date" : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function versionText(v) {
  const parts = [dayText(v.created_at), stateText(v.review_state)];
  const links = count(v.pending_links);
  const claims = count(v.pending_claims);
  if (v.review_state === "pending" && links + claims > 0) {
    parts.push([links ? plural(links, "link", "links") : "", claims ? plural(claims, "claim", "claims") : ""].filter(Boolean).join(" and ") + " to review");
  }
  return parts.join(" - ");
}

// A name a person can tell apart: the domain, the repo, or a short id as a last resort. Two sites that would
// read the same get their short id added.
export function siteLabels(sites) {
  const base = sites.map((s) => {
    const short = "Site " + String(s.id).slice(0, 8);
    if (s.domain && s.repo_full_name) return s.domain + " (" + s.repo_full_name + ")";
    return s.domain || s.repo_full_name || short;
  });
  return base.map((label, i) => (base.indexOf(label) === i && base.lastIndexOf(label) === i ? label : label + " - " + String(sites[i].id).slice(0, 8)));
}

// The newest version still awaiting approval; when none is, the newest one. `rows` is newest first.
export function pickDefault(rows) {
  return rows.find((v) => v.review_state === "pending") || rows[0] || null;
}

// Across sites: the newest pending version overall, else the newest overall. `groups` is [{ siteId, rows }].
export function pickAcross(groups) {
  let best = null;
  for (const g of groups) {
    for (const v of g.rows) {
      const pending = v.review_state === "pending";
      const better = !best || (pending && !best.pending) || (pending === best.pending && v.created_at > best.v.created_at);
      if (better) best = { siteId: g.siteId, v, pending };
    }
  }
  return best ? { siteId: best.siteId, version: best.v } : null;
}
