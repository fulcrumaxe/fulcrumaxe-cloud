// Dock folders ("stacks") for the Orchard heritage shell.
//
// Responsibilities:
//   - Render a folder item's DOM (2×2 mini-grid of child icons)
//   - Build + manage the Launchpad-style expansion overlay
//   - Wire HTML5 drag-drop for reordering and for combining two apps into a
//     folder (drop on the center of another item)
//
// All mutations go through orchard-dock-layout.ts; after each one we persist
// and call the caller's `rerender()` to rebuild the dock.
import { buildOrchardIcon } from "./orchard-icons.js";
import { createFolder, addToFolder, moveSlot, saveLayout, findAppContainer, } from "./orchard-dock-layout.js";
function appTitle(appId) {
    const app = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
    return (app && app.title) || appId;
}
function appIconNode(appId) {
    const wrap = document.createElement("div");
    wrap.className = "orchard-dock-icon";
    const iconSvg = buildOrchardIcon(appId);
    if (iconSvg) {
        wrap.appendChild(iconSvg);
        wrap.style.color = "rgba(255,255,255,0.82)";
    }
    else {
        const app = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
        wrap.textContent = (app && app.icon) || "◈";
    }
    return wrap;
}
export function createFolders(deps) {
    let overlay = null;
    let currentFolderId = null;
    let escHandler = null;
    function buildFolderItemEl(folder) {
        const item = document.createElement("div");
        item.className = "orchard-dock-item orchard-dock-folder";
        item.dataset.folderId = folder.id;
        item.dataset.folderApps = folder.apps.join(",");
        const icon = document.createElement("div");
        icon.className = "orchard-dock-icon orchard-dock-folder-icon";
        const grid = document.createElement("div");
        grid.className = "orchard-dock-folder-grid";
        // Show up to 4 child icons in 2×2
        const preview = folder.apps.slice(0, 4);
        preview.forEach((appId) => {
            const mini = document.createElement("div");
            mini.className = "orchard-dock-folder-mini";
            const miniSvg = buildOrchardIcon(appId);
            if (miniSvg)
                mini.appendChild(miniSvg);
            else {
                const a = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
                mini.textContent = (a && a.icon) || "◈";
            }
            grid.appendChild(mini);
        });
        // Pad to 4 slots so the grid shape stays consistent
        for (let i = preview.length; i < 4; i++) {
            const blank = document.createElement("div");
            blank.className = "orchard-dock-folder-mini empty";
            grid.appendChild(blank);
        }
        icon.appendChild(grid);
        const label = document.createElement("span");
        label.className = "orchard-dock-label";
        label.textContent = folder.name;
        const dot = document.createElement("span");
        dot.className = "orchard-dock-dot";
        item.appendChild(icon);
        item.appendChild(label);
        item.appendChild(dot);
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            openFolder(folder.id);
        });
        return item;
    }
    function openFolder(folderId) {
        if (currentFolderId)
            closeFolder();
        const folder = deps.layout.slots.find((s) => s.type === "folder" && s.id === folderId);
        if (!folder)
            return;
        overlay = document.createElement("div");
        overlay.className = "orchard-dock-expand";
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay)
                closeFolder();
        });
        const panel = document.createElement("div");
        panel.className = "orchard-dock-expand-panel";
        const title = document.createElement("div");
        title.className = "orchard-dock-expand-title";
        title.textContent = folder.name;
        panel.appendChild(title);
        const ent = window.FULCEntitlements;
        // Filter visible apps for the expand grid
        const visibleApps = folder.apps.filter((appId) => {
            if (!ent)
                return true;
            const app = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
            const def = app || { id: appId };
            return !ent.isAppHidden(def);
        });
        const grid = document.createElement("div");
        grid.className = "orchard-dock-expand-grid";
        const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(visibleApps.length || 1))));
        grid.style.gridTemplateColumns = `repeat(${cols}, 88px)`;
        visibleApps.forEach((appId) => {
            const app = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
            const def = app || { id: appId };
            const cell = document.createElement("div");
            cell.className = "orchard-dock-expand-item";
            const iconEl = appIconNode(appId);
            iconEl.classList.add("orchard-dock-expand-icon");
            const labelEl = document.createElement("span");
            labelEl.className = "orchard-dock-expand-label";
            labelEl.textContent = appTitle(appId);
            cell.appendChild(iconEl);
            cell.appendChild(labelEl);
            cell.addEventListener("click", () => {
                window.FULCWM?.open(appId);
                closeFolder();
            });
            // Apply lock overlay for denied-but-visible apps in folder expand view
            if (ent)
                ent.applyGate(cell, def);
            grid.appendChild(cell);
        });
        panel.appendChild(grid);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        currentFolderId = folderId;
        // Trigger the enter animation on next frame
        requestAnimationFrame(() => {
            overlay?.classList.add("open");
        });
        escHandler = (e) => {
            if (e.key === "Escape")
                closeFolder();
        };
        document.addEventListener("keydown", escHandler);
    }
    function closeFolder() {
        if (!overlay)
            return;
        const o = overlay;
        o.classList.remove("open");
        o.classList.add("closing");
        setTimeout(() => { o.remove(); }, 160);
        overlay = null;
        currentFolderId = null;
        if (escHandler) {
            document.removeEventListener("keydown", escHandler);
            escHandler = null;
        }
    }
    function clearDropHints() {
        document
            .querySelectorAll(".orchard-dock-item")
            .forEach((el) => {
            el.classList.remove("drag-over-merge", "drag-over-before", "drag-over-after");
        });
    }
    function dropZone(el, clientX) {
        const r = el.getBoundingClientRect();
        const x = clientX - r.left;
        const w = r.width;
        if (x < w * 0.3)
            return "before";
        if (x > w * 0.7)
            return "after";
        return "merge";
    }
    function wireDragDrop(el, slotIndex) {
        el.draggable = true;
        el.dataset.slotIndex = String(slotIndex);
        el.addEventListener("dragstart", (e) => {
            if (!e.dataTransfer)
                return;
            e.dataTransfer.effectAllowed = "move";
            // Payload is the source slot index; we re-read the current layout at
            // drop time so mutations during drag don't corrupt state.
            e.dataTransfer.setData("application/x-orchard-slot", String(slotIndex));
            el.classList.add("dragging");
        });
        el.addEventListener("dragend", () => {
            el.classList.remove("dragging");
            clearDropHints();
        });
        el.addEventListener("dragover", (e) => {
            if (!e.dataTransfer)
                return;
            // Only accept our own payload
            if (!e.dataTransfer.types.includes("application/x-orchard-slot"))
                return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const zone = dropZone(el, e.clientX);
            clearDropHints();
            el.classList.add(`drag-over-${zone}`);
        });
        el.addEventListener("dragleave", () => {
            el.classList.remove("drag-over-merge", "drag-over-before", "drag-over-after");
        });
        el.addEventListener("drop", (e) => {
            e.preventDefault();
            const fromStr = e.dataTransfer?.getData("application/x-orchard-slot");
            clearDropHints();
            if (fromStr == null || fromStr === "")
                return;
            const fromIdx = parseInt(fromStr, 10);
            if (!Number.isFinite(fromIdx))
                return;
            const toIdx = slotIndex;
            if (fromIdx === toIdx)
                return;
            const zone = dropZone(el, e.clientX);
            const fromSlot = deps.layout.slots[fromIdx];
            const toSlot = deps.layout.slots[toIdx];
            if (!fromSlot || !toSlot)
                return;
            if (zone === "merge") {
                // Merge: create folder (app+app), or add to folder (app→folder), or
                // fold folder-into-folder (combine contents).
                if (fromSlot.type === "app" && toSlot.type === "app") {
                    createFolder(deps.layout, toIdx, fromSlot.id);
                }
                else if (fromSlot.type === "app" && toSlot.type === "folder") {
                    addToFolder(deps.layout, toSlot.id, fromSlot.id);
                }
                else if (fromSlot.type === "folder" && toSlot.type === "app") {
                    // Add the lone app into the dragged folder, keep folder's position
                    const targetAppId = toSlot.id;
                    // remove toSlot from layout so addToFolder's reconcile is clean
                    const container = findAppContainer(deps.layout, targetAppId);
                    if (container)
                        addToFolder(deps.layout, fromSlot.id, targetAppId);
                }
                else if (fromSlot.type === "folder" && toSlot.type === "folder") {
                    // merge all of fromSlot.apps into toSlot
                    const movingApps = [...fromSlot.apps];
                    movingApps.forEach((id) => addToFolder(deps.layout, toSlot.id, id));
                }
            }
            else {
                // Reorder
                const insertAt = zone === "after" ? toIdx + 1 : toIdx;
                moveSlot(deps.layout, fromIdx, insertAt);
            }
            saveLayout(deps.layout);
            deps.rerender();
        });
    }
    function teardown() {
        closeFolder();
    }
    return { buildFolderItemEl, openFolder, closeFolder, wireDragDrop, teardown };
}
//# sourceMappingURL=orchard-dock-folders.js.map