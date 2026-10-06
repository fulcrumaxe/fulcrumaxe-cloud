// ── fulcrumaxe-os Update Notification Widget (epic-34 task 11) ─────────────────
// Shared widget for desktop / cloud-manage / app-store update banners.
// Vanilla JS module; exposes `window.FULCUpdateNotification`.
//
// State shape:
//   {
//     kind: "none" | "available" | "forced",
//     version: "1.2.3",
//     severity: 1..10,
//     summary: "...",
//     changes: [{ type, title }],
//     deadline: "2026-04-30T00:00:00Z" | null,
//     notesUrl: "..." | null,
//     actionLabel: "Update now",
//     surface: "desktop" | "cloud" | "app-store"
//   }

const SEVERITY_LABELS = [
    "", "Cosmetic", "Minor", "Cosmetic",
    "Recommended", "Recommended", "Recommended",
    "Important", "Critical", "Severe", "Emergency",
];

function severityLabel(n) {
    const i = typeof n === "number" ? n : 0;
    if (i < 1) return "";
    if (i > 10) return "Emergency";
    return SEVERITY_LABELS[i];
}

function severityTier(n) {
    if (typeof n !== "number") return "info";
    if (n >= 8) return "critical";
    if (n >= 4) return "warn";
    return "info";
}

function formatCountdown(deadlineISO) {
    if (!deadlineISO) return null;
    const t = Date.parse(deadlineISO);
    if (Number.isNaN(t)) return null;
    const ms = t - Date.now();
    if (ms <= 60_000) return "<1m";
    const total = Math.floor(ms / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function renderBanner(host, state, callbacks) {
    if (!host) return;
    host.replaceChildren();
    if (!state || state.kind === "none" || !state.version) return;

    const tier = severityTier(state.severity);
    const banner = el("div", `upd-banner upd-banner-${tier}`);
    banner.setAttribute("role", "status");
    banner.dataset.surface = state.surface || "unknown";
    banner.dataset.kind = state.kind;

    const head = el("div", "upd-banner-head");
    const dot = el("span", "upd-dot");
    head.appendChild(dot);

    const titleWrap = el("div", "upd-banner-title-wrap");
    const title = el("div", "upd-banner-title");
    title.textContent = state.kind === "forced"
        ? `Update required — ${state.version}`
        : `Update available — ${state.version}`;
    titleWrap.appendChild(title);

    const sev = severityLabel(state.severity);
    if (sev) {
        const meta = el("div", "upd-banner-meta");
        meta.textContent = sev.toUpperCase();
        titleWrap.appendChild(meta);
    }
    head.appendChild(titleWrap);

    const countdown = formatCountdown(state.deadline);
    if (countdown && state.kind === "forced") {
        const c = el("span", "upd-banner-countdown", countdown);
        c.title = `Auto-applies after ${state.deadline}`;
        head.appendChild(c);
    }
    banner.appendChild(head);

    if (state.summary) {
        banner.appendChild(el("p", "upd-banner-summary", state.summary));
    }

    if (Array.isArray(state.changes) && state.changes.length) {
        const ul = el("ul", "upd-banner-changes");
        const max = 4;
        state.changes.slice(0, max).forEach((c) => {
            const li = el("li");
            const tag = el("span", `upd-change-tag upd-change-${(c.type || "change").toLowerCase()}`);
            tag.textContent = c.type || "change";
            li.appendChild(tag);
            li.appendChild(document.createTextNode(" " + (c.title || "")));
            ul.appendChild(li);
        });
        if (state.changes.length > max) {
            const more = el("li", "upd-banner-more");
            more.textContent = `…and ${state.changes.length - max} more`;
            ul.appendChild(more);
        }
        banner.appendChild(ul);
    }

    const actions = el("div", "upd-banner-actions");
    if (state.notesUrl) {
        const notes = el("a", "upd-banner-notes", "What's changing");
        notes.href = state.notesUrl;
        notes.target = "_blank";
        notes.rel = "noopener";
        actions.appendChild(notes);
    }
    if (callbacks && typeof callbacks.onAction === "function") {
        const btn = el("button", "upd-banner-action", state.actionLabel || "Update now");
        btn.type = "button";
        btn.addEventListener("click", () => callbacks.onAction(state));
        actions.appendChild(btn);
    }
    if (state.kind !== "forced" && callbacks && typeof callbacks.onDismiss === "function") {
        const dismiss = el("button", "upd-banner-dismiss", "Later");
        dismiss.type = "button";
        dismiss.addEventListener("click", () => callbacks.onDismiss(state));
        actions.appendChild(dismiss);
    }
    if (actions.children.length) banner.appendChild(actions);

    host.appendChild(banner);
}

function renderTrayBadge(state) {
    if (!state || state.kind === "none" || !state.version) return null;
    const tier = severityTier(state.severity);
    // Native <button>, not a <span>: tray-update-indicator.js wires a click on
    // this badge and it is the ONLY tray route to the updates app, so a bare
    // span left a keyboard user unable to reach updates at all (D#649 PR 3).
    const badge = el("button", `upd-tray-badge upd-tray-${tier}`);
    badge.type = "button";
    badge.textContent = "↑";
    const label = state.kind === "forced"
        ? `Update required — ${state.version}`
        : `Update available — ${state.version}`;
    badge.title = label;
    // The glyph is a decorative arrow; the accessible name has to carry the
    // version, or a screen reader announces the control as "up arrow".
    badge.setAttribute("aria-label", label);
    return badge;
}

function renderForcedModal(state, callbacks) {
    const overlay = el("div", "upd-modal-overlay");
    const modal = el("div", `upd-modal upd-banner-${severityTier(state.severity)}`);
    modal.appendChild(el("h2", "upd-modal-title", `Update required: ${state.version}`));
    const sev = severityLabel(state.severity);
    if (sev) modal.appendChild(el("div", "upd-modal-severity", sev.toUpperCase()));
    if (state.summary) modal.appendChild(el("p", "upd-modal-summary", state.summary));

    const countdown = formatCountdown(state.deadline);
    if (countdown) {
        const c = el("div", "upd-modal-countdown");
        c.textContent = `Auto-applies in ${countdown}`;
        modal.appendChild(c);
    }

    const actions = el("div", "upd-modal-actions");
    const apply = el("button", "upd-modal-apply", state.actionLabel || "Update now");
    apply.type = "button";
    apply.addEventListener("click", () => callbacks && callbacks.onAction && callbacks.onAction(state));
    actions.appendChild(apply);

    if (callbacks && typeof callbacks.onDefer === "function") {
        const defer = el("button", "upd-modal-defer", "Defer");
        defer.type = "button";
        defer.addEventListener("click", () => callbacks.onDefer(state));
        actions.appendChild(defer);
    }
    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
}

export const FULCUpdateNotification = {
    renderBanner,
    renderTrayBadge,
    renderForcedModal,
    formatCountdown,
    severityLabel,
    severityTier,
};

if (typeof window !== "undefined") {
    window.FULCUpdateNotification = FULCUpdateNotification;
}
