// Live running / focused / minimized indicator state for the Orchard dock.
//
// Implementation: pure polling. We run a 200ms interval that reads
// `FULCWM.getOpen()` + `getActive()` and syncs `.running`, `.active`,
// `.minimized` classes on every `.orchard-dock-item[data-app-id]` and
// `[data-folder-id]`. No method wrapping — that turned out to be fragile
// across theme toggles because wrappers stack, and undoing them in the
// wrong order corrupts FULCWM.
//
// 200ms is well below perceptual latency for indicator changes and costs
// almost nothing — the sync reads two short arrays and toggles classList.
const POLL_INTERVAL_MS = 200;
export function createDockState() {
    let pollId = null;
    const listeners = [];
    function onChange(cb) {
        listeners.push(cb);
    }
    function refresh() {
        const wm = window.FULCWM;
        if (!wm)
            return;
        const open = wm.getOpen ? wm.getOpen() : [];
        const active = wm.getActive ? wm.getActive() : null;
        const runningByApp = new Map();
        for (const win of open) {
            const isMin = win.state === "minimized";
            const existing = runningByApp.get(win.id);
            if (!existing) {
                runningByApp.set(win.id, { minimized: isMin });
            }
            else if (!isMin) {
                existing.minimized = false;
            }
        }
        const activeId = active ? active.id : null;
        // Per-app dock items
        const appItems = document.querySelectorAll('.orchard-dock-item[data-app-id]');
        appItems.forEach((el) => {
            const appId = el.dataset.appId;
            if (!appId)
                return;
            const info = runningByApp.get(appId);
            el.classList.toggle("running", !!info);
            el.classList.toggle("active", !!info && activeId === appId && !info.minimized);
            el.classList.toggle("minimized", !!info && info.minimized);
        });
        // Folder items (aggregate: running if any child running)
        const folderItems = document.querySelectorAll('.orchard-dock-item[data-folder-id]');
        folderItems.forEach((el) => {
            const childIds = (el.dataset.folderApps || "").split(",").filter(Boolean);
            const anyRunning = childIds.some((id) => runningByApp.has(id));
            const anyActive = childIds.some((id) => activeId === id);
            const allMin = anyRunning && childIds.every((id) => {
                const info = runningByApp.get(id);
                return !info || info.minimized;
            });
            el.classList.toggle("running", anyRunning);
            el.classList.toggle("active", anyActive);
            el.classList.toggle("minimized", allMin);
        });
        // Notify listeners (e.g. the minimized zone rerenders on state change
        // so it catches closes that happened via window traffic lights).
        for (const cb of listeners) {
            try {
                cb({ type: "refresh" });
            }
            catch { /* ignore */ }
        }
    }
    function start() {
        if (pollId !== null)
            return;
        refresh();
        pollId = setInterval(refresh, POLL_INTERVAL_MS);
    }
    function stop() {
        if (pollId !== null) {
            clearInterval(pollId);
            pollId = null;
        }
        listeners.length = 0;
    }
    return { start, stop, refresh, onChange };
}
//# sourceMappingURL=orchard-dock-state.js.map