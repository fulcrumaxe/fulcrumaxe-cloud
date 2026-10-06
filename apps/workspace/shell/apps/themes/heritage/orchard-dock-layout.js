// Layout model + persistence for the Orchard dock.
//
// The layout is a flat list of *slots*. Each slot is either a single app
// ("app") or a user-created folder containing one or more apps ("folder").
// We persist this to localStorage under `orchard-dock-layout-v1` so users
// keep their layout across reloads and theme switches.
const STORAGE_KEY = "orchard-dock-layout-v1";
const DEFAULT_APPS = [
    "terminal",
    "file-manager",
    "kanban",
    "agents",
    "package-manager",
    "themes",
    "browser",
];
function defaultLayout(availableIds) {
    const seen = new Set();
    const slots = [];
    for (const id of DEFAULT_APPS) {
        if (availableIds.includes(id) && !seen.has(id)) {
            slots.push({ type: "app", id });
            seen.add(id);
        }
    }
    for (const id of availableIds) {
        if (!seen.has(id)) {
            slots.push({ type: "app", id });
            seen.add(id);
        }
    }
    return { slots };
}
export function loadLayout(availableIds) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.slots)) {
                reconcileWithAvailable(parsed, availableIds);
                return parsed;
            }
        }
    }
    catch {
        // fall through to default
    }
    return defaultLayout(availableIds);
}
export function saveLayout(layout) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    }
    catch {
        // ignore quota errors — dock layout is tiny but localStorage can fail
    }
}
function reconcileWithAvailable(layout, availableIds) {
    const available = new Set(availableIds);
    layout.slots = layout.slots.filter((slot) => {
        if (slot.type === "app")
            return available.has(slot.id);
        slot.apps = slot.apps.filter((id) => available.has(id));
        return slot.apps.length > 0;
    });
}
export function findAppContainer(layout, appId) {
    for (let i = 0; i < layout.slots.length; i++) {
        const s = layout.slots[i];
        if (s.type === "app" && s.id === appId)
            return { slotIndex: i, folderId: null };
        if (s.type === "folder" && s.apps.includes(appId))
            return { slotIndex: i, folderId: s.id };
    }
    return null;
}
export function isAppPinned(layout, appId) {
    return findAppContainer(layout, appId) !== null;
}
export function addApp(layout, appId) {
    if (isAppPinned(layout, appId))
        return;
    layout.slots.push({ type: "app", id: appId });
}
export function removeApp(layout, appId) {
    for (let i = layout.slots.length - 1; i >= 0; i--) {
        const s = layout.slots[i];
        if (s.type === "app" && s.id === appId) {
            layout.slots.splice(i, 1);
        }
        else if (s.type === "folder") {
            s.apps = s.apps.filter((id) => id !== appId);
            if (s.apps.length === 0)
                layout.slots.splice(i, 1);
            else if (s.apps.length === 1) {
                layout.slots[i] = { type: "app", id: s.apps[0] };
            }
        }
    }
}
function newFolderId() {
    return "f" + Math.random().toString(36).slice(2, 10);
}
export function createFolder(layout, targetSlotIndex, droppedAppId) {
    const target = layout.slots[targetSlotIndex];
    if (!target || target.type !== "app")
        return null;
    if (target.id === droppedAppId)
        return null;
    // remove droppedAppId from wherever it currently is
    removeApp(layout, droppedAppId);
    // target may have shifted
    const newTargetIdx = layout.slots.findIndex((s) => s.type === "app" && s.id === target.id);
    if (newTargetIdx < 0)
        return null;
    const folderId = newFolderId();
    layout.slots[newTargetIdx] = {
        type: "folder",
        id: folderId,
        name: "Folder",
        apps: [target.id, droppedAppId],
    };
    return folderId;
}
export function addToFolder(layout, folderId, appId) {
    // find folder
    const folder = layout.slots.find((s) => s.type === "folder" && s.id === folderId);
    if (!folder)
        return false;
    if (folder.apps.includes(appId))
        return false;
    removeApp(layout, appId);
    // folder reference could be stale after removal, but folder objects live in
    // the array — we mutate in place — so locate it again to be safe.
    const again = layout.slots.find((s) => s.type === "folder" && s.id === folderId);
    if (!again)
        return false;
    again.apps.push(appId);
    return true;
}
export function removeFromFolder(layout, folderId, appId) {
    const idx = layout.slots.findIndex((s) => s.type === "folder" && s.id === folderId);
    if (idx < 0)
        return;
    const folder = layout.slots[idx];
    folder.apps = folder.apps.filter((id) => id !== appId);
    if (folder.apps.length === 0) {
        layout.slots.splice(idx, 1);
    }
    else if (folder.apps.length === 1) {
        layout.slots[idx] = { type: "app", id: folder.apps[0] };
    }
}
export function renameFolder(layout, folderId, name) {
    const folder = layout.slots.find((s) => s.type === "folder" && s.id === folderId);
    if (folder)
        folder.name = name || "Folder";
}
export function ungroupFolder(layout, folderId) {
    const idx = layout.slots.findIndex((s) => s.type === "folder" && s.id === folderId);
    if (idx < 0)
        return;
    const folder = layout.slots[idx];
    const replacement = folder.apps.map((id) => ({ type: "app", id }));
    layout.slots.splice(idx, 1, ...replacement);
}
export function moveSlot(layout, fromIdx, toIdx) {
    if (fromIdx === toIdx)
        return;
    if (fromIdx < 0 || fromIdx >= layout.slots.length)
        return;
    if (toIdx < 0 || toIdx > layout.slots.length)
        return;
    const [moved] = layout.slots.splice(fromIdx, 1);
    // after splice, adjust toIdx if it was past fromIdx
    const target = toIdx > fromIdx ? toIdx - 1 : toIdx;
    layout.slots.splice(target, 0, moved);
}
//# sourceMappingURL=orchard-dock-layout.js.map