// Window-manipulation helpers scoped to the current app id. Wraps the
// desktop's `FULCWM` so apps don't have to repeat their id with every call.
import { requireAppId, debugLog } from "./internal.js";
function fulcWM() {
    if (typeof window === "undefined")
        return null;
    return window.FULCWM ?? null;
}
function getMyWindowEl(id) {
    const wm = fulcWM();
    const list = wm?.getOpen?.() ?? [];
    for (const w of list) {
        if (w.id === id && w.el instanceof HTMLElement)
            return w.el;
    }
    return null;
}
export const windowApi = {
    setTitle(title) {
        const id = requireAppId("window.setTitle");
        const wm = fulcWM();
        try {
            wm?.renameWindow?.(id, title);
        }
        catch (err) {
            console.warn(`fulcrumaxe-os window.setTitle("${title}"):`, err);
        }
    },
    resize(size) {
        const id = requireAppId("window.resize");
        if (!size || typeof size.w !== "number" || typeof size.h !== "number") {
            throw new TypeError("fulcrumaxe-os window.resize: size.w and size.h must be numbers");
        }
        // No public WM method for programmatic resize; set the inline style on
        // the window element. The window manager observes content reflows and
        // re-snaps as needed.
        const el = getMyWindowEl(id);
        if (!el) {
            debugLog(`window.resize: no open window for "${id}"`);
            return;
        }
        el.style.width = `${size.w}px`;
        el.style.height = `${size.h}px`;
    },
    close() {
        const id = requireAppId("window.close");
        fulcWM()?.close?.(id);
    },
    focus() {
        const id = requireAppId("window.focus");
        fulcWM()?.focus?.(id);
    },
    isOpen() {
        const id = requireAppId("window.isOpen");
        return !!fulcWM()?.isOpen?.(id);
    },
};
//# sourceMappingURL=window.js.map