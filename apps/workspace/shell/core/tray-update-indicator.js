// ── fulcrumaxe-os Tray Update Indicator (epic-34 task 11) ──────────────────────
// Polls /api/updates/status and surfaces a clickable badge in the system
// tray when an update is available. Click opens the Updates app.
//
// Decoupled from system-tray.js so the tray module stays focused on
// platform indicators (wifi/volume/battery/power) — the update badge
// shares the same tray container but is wholly owned here.

// D#37 WS-B (fork edit, read flags only): gates start() on
// features.updates -- see start() below.
import { getFeatures } from "./features.js";

const POLL_MS = 30_000;
const BADGE_ID = "tray-update-badge";

let timer = null;
let lastVersion = null;

function getTrayContainer() {
    return document.getElementById("taskbar-tray");
}

function removeBadge() {
    const existing = document.getElementById(BADGE_ID);
    if (existing) existing.remove();
}

function openUpdatesApp() {
    const wm = window.FULCWM;
    if (wm && typeof wm.open === "function") {
        wm.open("updates");
    }
}

function stateFromStatus(status) {
    if (!status || !status.available || !status.available.version) return null;
    const a = status.available;
    const severity = (a.severity != null) ? a.severity : 4;
    return {
        kind: severity >= 8 ? "forced" : "available",
        version: a.version,
        severity,
        summary: a.summary || "",
        changes: Array.isArray(a.changes) ? a.changes : [],
        deadline: a.force_update_after || null,
        surface: "desktop",
    };
}

function render(state) {
    const tray = getTrayContainer();
    if (!tray) return;
    removeBadge();
    const widget = window.FULCUpdateNotification;
    if (!widget) return;
    const badge = widget.renderTrayBadge(state);
    if (!badge) return;
    badge.id = BADGE_ID;
    badge.addEventListener("click", openUpdatesApp);
    // Insert before the indicators block (or as the first child if not yet rendered)
    const indicators = document.getElementById("system-tray-indicators");
    if (indicators) {
        tray.insertBefore(badge, indicators);
    } else {
        tray.insertBefore(badge, tray.firstChild);
    }
}

async function poll() {
    try {
        const r = await fetch("/api/updates/status");
        if (!r.ok) return;
        const status = await r.json();
        const state = stateFromStatus(status);
        if (!state) {
            removeBadge();
            lastVersion = null;
            return;
        }
        if (state.version !== lastVersion) {
            lastVersion = state.version;
            render(state);
        }
    } catch (_e) { /* ignore network errors; retry next tick */ }
}

async function start() {
    if (timer) return;
    // D#37 WS-B: cloud profile disables updates entirely -- no poll, no
    // interval. Checked before the first poll() so a disabled deployment
    // never makes the initial request either.
    const features = await getFeatures();
    if (features && features.updates === false) return;
    if (timer) return; // re-check: a concurrent start() may have won the race
    poll();
    timer = setInterval(poll, POLL_MS);
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    removeBadge();
}

export const FULCTrayUpdateIndicator = { start, stop, poll };
if (typeof window !== "undefined") {
    window.FULCTrayUpdateIndicator = FULCTrayUpdateIndicator;
}

// Auto-start once the tray container exists.
function maybeStart() {
    if (getTrayContainer()) {
        start();
        return true;
    }
    return false;
}
if (!maybeStart()) {
    document.addEventListener("DOMContentLoaded", () => {
        if (!maybeStart()) {
            // Tray may be created later by boot.js; retry briefly.
            const retry = setInterval(() => {
                if (maybeStart()) clearInterval(retry);
            }, 1000);
            setTimeout(() => clearInterval(retry), 30_000);
        }
    });
}
