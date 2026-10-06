// Right-click context menus for Orchard dock items. Uses the global
// FULCContextMenu API exported by core/context-menu.js.
//
// The caller wires `contextmenu` listeners in the adapter; this module just
// builds + shows the menus and calls back into the layout/WM.
import { isAppPinned, addApp, removeApp, ungroupFolder, renameFolder, removeFromFolder, saveLayout, } from "./orchard-dock-layout.js";
// FULCContextMenu is a module export, not a window global. Import it directly.
// The file-extension convention matches sibling imports (all .js after tsc).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { FULCContextMenu } from "../../../core/context-menu.js";
import { workspaceMenuItems, switchWorkspaceItems } from "../../../core/workspace-actions.js";
function appTitle(appId) {
    const app = window.FULCApps?.get ? window.FULCApps.get(appId) : null;
    return (app && app.title) || appId;
}
function showMenu(e, items) {
    if (!FULCContextMenu || typeof FULCContextMenu.show !== "function")
        return;
    e.preventDefault();
    e.stopPropagation();
    FULCContextMenu.show(e, items);
}
function isAppRunning(appId) {
    const wm = window.FULCWM;
    if (!wm || !wm.getOpen)
        return false;
    return wm.getOpen().some((w) => w.id === appId);
}
function isAppMinimized(appId) {
    const wm = window.FULCWM;
    if (!wm || !wm.getOpen)
        return false;
    return wm.getOpen().some((w) => w.id === appId && w.state === "minimized");
}
export function showAppMenu(e, appId, deps) {
    const { layout, rerender } = deps;
    const wm = window.FULCWM;
    const running = isAppRunning(appId);
    const minimized = isAppMinimized(appId);
    const pinned = isAppPinned(layout, appId);
    const items = [];
    if (running) {
        if (minimized) {
            items.push({
                label: "Show",
                action: () => { wm?.restore(appId); wm?.focus(appId); },
            });
        }
        else {
            items.push({
                label: "Hide",
                action: () => { wm?.minimize(appId); },
            });
        }
        items.push({
            label: "Show All Windows",
            action: () => { wm?.focus(appId); },
        });
        items.push({ divider: true });
        // D#37 WS-W3: Go to / Move to This / Move to Workspace (none on a phone).
        const wsItems = workspaceMenuItems(appId);
        if (wsItems.length) {
            items.push(...wsItems);
            items.push({ divider: true });
        }
    }
    else {
        items.push({
            label: "Open",
            action: () => { wm?.open(appId); },
        });
        items.push({ divider: true });
    }
    // Options submenu
    const optionsSub = [];
    if (pinned) {
        optionsSub.push({
            label: "Remove from Dock",
            action: () => { removeApp(layout, appId); saveLayout(layout); rerender(); },
        });
    }
    else {
        optionsSub.push({
            label: "Keep in Dock",
            action: () => { addApp(layout, appId); saveLayout(layout); rerender(); },
        });
    }
    items.push({ label: "Options", submenu: optionsSub });
    if (running) {
        items.push({ divider: true });
        items.push({
            label: "Quit",
            danger: true,
            action: () => { wm?.close(appId); },
        });
    }
    // Header row (disabled, informational)
    items.unshift({ divider: true });
    items.unshift({ label: appTitle(appId), disabled: true });
    showMenu(e, items);
}
export function showFolderMenu(e, folderId, deps) {
    const { layout, rerender, openFolder } = deps;
    const folder = layout.slots.find((s) => s.type === "folder" && s.id === folderId);
    if (!folder)
        return;
    const items = [
        { label: folder.name, disabled: true },
        { divider: true },
        {
            label: "Open Folder",
            action: () => openFolder(folderId),
        },
        {
            label: "Rename…",
            action: () => {
                const name = window.prompt("Folder name:", folder.name);
                if (name !== null) {
                    renameFolder(layout, folderId, name.trim());
                    saveLayout(layout);
                    rerender();
                }
            },
        },
        {
            label: "Ungroup",
            action: () => { ungroupFolder(layout, folderId); saveLayout(layout); rerender(); },
        },
    ];
    // Submenu: per-child actions
    if (folder.apps.length > 0) {
        const contents = folder.apps.map((appId) => ({
            label: `Remove "${appTitle(appId)}"`,
            action: () => {
                removeFromFolder(layout, folderId, appId);
                saveLayout(layout);
                rerender();
            },
        }));
        items.push({ divider: true });
        items.push({ label: "Contents", submenu: contents });
    }
    showMenu(e, items);
}
export function showMinimizedMenu(e, windowId, appId, deps) {
    void windowId; // reserved for future per-window operations
    const { layout, rerender } = deps;
    const wm = window.FULCWM;
    const items = [
        { label: appTitle(appId), disabled: true },
        { divider: true },
        {
            label: "Show",
            action: () => { wm?.restore(appId); wm?.focus(appId); },
        },
        ...workspaceMenuItems(appId),
        {
            label: "Close",
            danger: true,
            action: () => { wm?.close(appId); },
        },
        { divider: true },
        isAppPinned(layout, appId)
            ? { label: "Remove from Dock", action: () => { removeApp(layout, appId); saveLayout(layout); rerender(); } }
            : { label: "Keep in Dock", action: () => { addApp(layout, appId); saveLayout(layout); rerender(); } },
    ];
    showMenu(e, items);
}
/** D#37 WS-W3 criterion 6: the dock background menu. Nothing opens on a phone. */
export function showDockMenu(e) {
    const items = switchWorkspaceItems();
    if (!items.length)
        return;
    showMenu(e, items);
}
//# sourceMappingURL=orchard-dock-menu.js.map