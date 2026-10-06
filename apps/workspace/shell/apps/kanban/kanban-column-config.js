// ── Kanban Column Config ────────────────────────────────────────────
// Per-project column customization: labels, colors, ordering, hidden
// state, and custom columns. Persisted to localStorage. Provides the
// color picker popup, column-header context menu, inline rename, and
// HTML5 drag-to-reorder for column headers.
//
// Built-in columns map to the SQLite `tasks.status` CHECK constraint
// (todo, inprogress, inreview, done, cancelled) so they can never be
// removed — only hidden. Custom columns are CRDT-only because their
// status string would violate the CHECK constraint in SQLite mode.
const STORAGE_PREFIX = "fulc-kanban-cols-";
const BUILTIN_IDS = ["todo", "inprogress", "inreview", "done", "cancelled"];
const DEFAULT_LABELS = {
    todo: "TODO",
    inprogress: "IN PROG",
    inreview: "REVIEW",
    done: "DONE",
    cancelled: "CANCELLED",
};
const DEFAULT_COLORS = {
    todo: "#6b7280",
    inprogress: "#3b82f6",
    inreview: "#a855f7",
    done: "#10b981",
    cancelled: "#ef4444",
};
const DEFAULT_PALETTE = [
    "#6b7280", "#3b82f6", "#a855f7", "#10b981", "#ef4444",
    "#f59e0b", "#06b6d4", "#ec4899", "#84cc16", "#f97316",
    "#14b8a6", "#8b5cf6", "#0ea5e9", "#eab308", "#dc2626",
    "#22c55e", "#fbbf24", "#f43f5e", "#0d9488", "#7c3aed",
];
function projectKey(pid) {
    if (pid === null || pid === undefined || pid === "")
        return null;
    return STORAGE_PREFIX + String(pid);
}
function defaultColumns() {
    const out = [];
    for (let i = 0; i < BUILTIN_IDS.length; i++) {
        const id = BUILTIN_IDS[i];
        out.push({
            id,
            label: DEFAULT_LABELS[id],
            color: DEFAULT_COLORS[id],
            hidden: false,
            builtin: true,
        });
    }
    return out;
}
function isHexColor(s) {
    return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}
function load(projectId) {
    const key = projectKey(projectId);
    if (!key)
        return defaultColumns();
    try {
        const raw = localStorage.getItem(key);
        if (!raw)
            return defaultColumns();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0)
            return defaultColumns();
        const seen = {};
        const cleaned = [];
        for (let i = 0; i < parsed.length; i++) {
            const c = parsed[i];
            if (!c || typeof c.id !== "string" || !c.id)
                continue;
            if (seen[c.id])
                continue;
            seen[c.id] = true;
            const isBuiltin = BUILTIN_IDS.indexOf(c.id) !== -1;
            cleaned.push({
                id: c.id,
                label: typeof c.label === "string" && c.label
                    ? c.label
                    : (DEFAULT_LABELS[c.id] || c.id.toUpperCase()),
                color: isHexColor(c.color)
                    ? c.color
                    : (DEFAULT_COLORS[c.id] || "#6b7280"),
                hidden: !!c.hidden,
                builtin: isBuiltin,
            });
        }
        // Always re-add any missing builtin (preserves data-integrity if
        // older saved configs lack a column).
        for (let i = 0; i < BUILTIN_IDS.length; i++) {
            const id = BUILTIN_IDS[i];
            if (!seen[id]) {
                cleaned.push({
                    id,
                    label: DEFAULT_LABELS[id],
                    color: DEFAULT_COLORS[id],
                    hidden: false,
                    builtin: true,
                });
            }
        }
        return cleaned;
    }
    catch (err) {
        console.warn("[kanban-column-config] load failed:", err);
        return defaultColumns();
    }
}
function save(projectId, columns) {
    const key = projectKey(projectId);
    if (!key)
        return;
    try {
        localStorage.setItem(key, JSON.stringify(columns));
    }
    catch (err) {
        console.warn("[kanban-column-config] save failed:", err);
    }
}
function visibleColumns(columns) {
    const out = [];
    for (let i = 0; i < columns.length; i++) {
        if (!columns[i].hidden)
            out.push(columns[i]);
    }
    return out;
}
function visibleCount(columns) {
    let n = 0;
    for (let i = 0; i < columns.length; i++) {
        if (!columns[i].hidden)
            n++;
    }
    return n;
}
function findColumn(columns, id) {
    for (let i = 0; i < columns.length; i++) {
        if (columns[i].id === id)
            return columns[i];
    }
    return null;
}
function indexOf(columns, id) {
    for (let i = 0; i < columns.length; i++) {
        if (columns[i].id === id)
            return i;
    }
    return -1;
}
function clone(columns) {
    const out = [];
    for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        out.push({
            id: c.id,
            label: c.label,
            color: c.color,
            hidden: c.hidden,
            builtin: c.builtin,
        });
    }
    return out;
}
function rename(columns, id, label) {
    const next = clone(columns);
    const i = indexOf(next, id);
    if (i >= 0)
        next[i].label = label;
    return next;
}
function setColor(columns, id, color) {
    const next = clone(columns);
    const i = indexOf(next, id);
    if (i >= 0 && isHexColor(color))
        next[i].color = color;
    return next;
}
function setHidden(columns, id, hidden) {
    const next = clone(columns);
    const i = indexOf(next, id);
    if (i < 0)
        return next;
    // Refuse to hide the last visible column.
    if (hidden && visibleCount(next) <= 1 && !next[i].hidden)
        return next;
    next[i].hidden = hidden;
    return next;
}
function removeCustom(columns, id) {
    const i = indexOf(columns, id);
    if (i < 0)
        return clone(columns);
    if (columns[i].builtin)
        return clone(columns);
    const next = clone(columns);
    next.splice(i, 1);
    return next;
}
function move(columns, id, direction) {
    const next = clone(columns);
    // Direction is computed against the visible-only view so users get
    // intuitive ordering even when builtins are hidden.
    const visible = visibleColumns(next);
    const visIdx = visible.findIndex((c) => c.id === id);
    if (visIdx < 0)
        return next;
    const targetVisIdx = visIdx + (direction > 0 ? 1 : -1);
    if (targetVisIdx < 0 || targetVisIdx >= visible.length)
        return next;
    const targetId = visible[targetVisIdx].id;
    const a = indexOf(next, id);
    const b = indexOf(next, targetId);
    if (a < 0 || b < 0)
        return next;
    const tmp = next[a];
    next[a] = next[b];
    next[b] = tmp;
    return next;
}
function reorderById(columns, idOrder) {
    const byId = {};
    for (let i = 0; i < columns.length; i++)
        byId[columns[i].id] = columns[i];
    const next = [];
    const seen = {};
    for (let i = 0; i < idOrder.length; i++) {
        const id = idOrder[i];
        if (byId[id] && !seen[id]) {
            next.push({ ...byId[id] });
            seen[id] = true;
        }
    }
    // Append anything not in idOrder (e.g. hidden builtins) to keep them.
    for (let i = 0; i < columns.length; i++) {
        if (!seen[columns[i].id])
            next.push({ ...columns[i] });
    }
    return next;
}
function addCustom(columns, label, color) {
    const next = clone(columns);
    // Generate unique id from label
    const slugBase = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    const base = "col-" + (slugBase || "custom");
    let id = base;
    let n = 1;
    while (indexOf(next, id) !== -1) {
        n++;
        id = base + "-" + n;
    }
    const column = {
        id,
        label,
        color: isHexColor(color) ? color : "#6b7280",
        hidden: false,
        builtin: false,
    };
    next.push(column);
    return { columns: next, column };
}
// ── Color picker popup ─────────────────────────────────────────────
let pickerEl = null;
function hidePicker() {
    if (pickerEl && pickerEl.parentNode) {
        pickerEl.parentNode.removeChild(pickerEl);
    }
    pickerEl = null;
    document.removeEventListener("click", onDocClickPicker, true);
    document.removeEventListener("keydown", onDocKeyPicker);
}
function onDocClickPicker(e) {
    if (!pickerEl)
        return;
    const t = e.target;
    if (pickerEl.contains(t))
        return;
    hidePicker();
}
function onDocKeyPicker(e) {
    if (e.key === "Escape")
        hidePicker();
}
function showColorPicker(opts) {
    hidePicker();
    const wrap = document.createElement("div");
    wrap.className = "kanban-color-picker";
    wrap.setAttribute("data-fulc-component", "kanban-color-picker");
    const title = document.createElement("div");
    title.className = "kanban-color-picker-title";
    title.textContent = "COLUMN COLOR";
    wrap.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "kanban-color-picker-grid";
    for (let i = 0; i < DEFAULT_PALETTE.length; i++) {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "kanban-color-swatch";
        swatch.style.background = DEFAULT_PALETTE[i];
        swatch.setAttribute("data-color", DEFAULT_PALETTE[i]);
        swatch.title = DEFAULT_PALETTE[i];
        if (DEFAULT_PALETTE[i].toLowerCase() === opts.current.toLowerCase()) {
            swatch.classList.add("selected");
        }
        swatch.addEventListener("click", function (e) {
            e.stopPropagation();
            opts.onChange(DEFAULT_PALETTE[i]);
            hidePicker();
        });
        grid.appendChild(swatch);
    }
    wrap.appendChild(grid);
    // Custom color row: native picker + hex input
    const customRow = document.createElement("div");
    customRow.className = "kanban-color-picker-custom";
    const label = document.createElement("span");
    label.className = "kanban-color-picker-label";
    label.textContent = "CUSTOM";
    customRow.appendChild(label);
    const native = document.createElement("input");
    native.type = "color";
    native.className = "kanban-color-picker-native";
    native.value = isHexColor(opts.current) ? opts.current : "#6b7280";
    customRow.appendChild(native);
    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "kanban-color-picker-hex";
    hexInput.placeholder = "#rrggbb";
    hexInput.value = native.value;
    hexInput.maxLength = 7;
    customRow.appendChild(hexInput);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "kanban-color-picker-apply";
    apply.textContent = "APPLY";
    customRow.appendChild(apply);
    function commit(value) {
        if (!isHexColor(value))
            return;
        opts.onChange(value);
        hidePicker();
    }
    native.addEventListener("input", function () {
        hexInput.value = native.value;
    });
    native.addEventListener("change", function () {
        commit(native.value);
    });
    hexInput.addEventListener("input", function () {
        if (isHexColor(hexInput.value)) {
            native.value = hexInput.value;
        }
    });
    hexInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter")
            commit(hexInput.value);
    });
    apply.addEventListener("click", function () {
        commit(hexInput.value);
    });
    wrap.appendChild(customRow);
    document.body.appendChild(wrap);
    pickerEl = wrap;
    // Position: clamp to viewport
    const rect = wrap.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = opts.x;
    let top = opts.y;
    if (left + rect.width > vw)
        left = Math.max(0, vw - rect.width - 8);
    if (top + rect.height > vh)
        top = Math.max(0, vh - rect.height - 8);
    if (left < 0)
        left = 0;
    if (top < 0)
        top = 0;
    wrap.style.left = left + "px";
    wrap.style.top = top + "px";
    setTimeout(function () {
        document.addEventListener("click", onDocClickPicker, true);
        document.addEventListener("keydown", onDocKeyPicker);
    }, 0);
}
// ── Add Column dialog ──────────────────────────────────────────────
let addDialogEl = null;
function hideAddDialog() {
    if (addDialogEl && addDialogEl.parentNode) {
        addDialogEl.parentNode.removeChild(addDialogEl);
    }
    addDialogEl = null;
    document.removeEventListener("keydown", onDocKeyAddDialog);
}
function onDocKeyAddDialog(e) {
    if (e.key === "Escape")
        hideAddDialog();
}
function promptAddColumn(opts) {
    hideAddDialog();
    const overlay = document.createElement("div");
    overlay.className = "kanban-add-column-overlay";
    overlay.addEventListener("click", function (e) {
        if (e.target === overlay)
            hideAddDialog();
    });
    const dialog = document.createElement("div");
    dialog.className = "kanban-add-column-dialog";
    const title = document.createElement("div");
    title.className = "kanban-add-column-title";
    title.textContent = "ADD COLUMN";
    dialog.appendChild(title);
    if (!opts.isCrdt) {
        const note = document.createElement("div");
        note.className = "kanban-add-column-note";
        note.textContent =
            "Custom columns require CRDT storage mode. Switch the project to CRDT to add new columns.";
        dialog.appendChild(note);
        const close = document.createElement("button");
        close.type = "button";
        close.className = "kanban-add-column-close";
        close.textContent = "OK";
        close.addEventListener("click", function () {
            hideAddDialog();
        });
        dialog.appendChild(close);
    }
    else {
        const labelRow = document.createElement("div");
        labelRow.className = "kanban-add-column-row";
        const labelLbl = document.createElement("span");
        labelLbl.className = "kanban-add-column-label";
        labelLbl.textContent = "NAME";
        const labelInput = document.createElement("input");
        labelInput.type = "text";
        labelInput.className = "kanban-add-column-input";
        labelInput.placeholder = "Column name";
        labelInput.maxLength = 32;
        labelRow.appendChild(labelLbl);
        labelRow.appendChild(labelInput);
        dialog.appendChild(labelRow);
        const colorRow = document.createElement("div");
        colorRow.className = "kanban-add-column-row";
        const colorLbl = document.createElement("span");
        colorLbl.className = "kanban-add-column-label";
        colorLbl.textContent = "COLOR";
        const colorPreview = document.createElement("button");
        colorPreview.type = "button";
        colorPreview.className = "kanban-add-column-color-preview";
        let chosenColor = "#3b82f6";
        colorPreview.style.background = chosenColor;
        colorPreview.textContent = chosenColor;
        colorPreview.addEventListener("click", function (e) {
            e.stopPropagation();
            const r = colorPreview.getBoundingClientRect();
            showColorPicker({
                x: r.left,
                y: r.bottom + 4,
                current: chosenColor,
                onChange(c) {
                    chosenColor = c;
                    colorPreview.style.background = c;
                    colorPreview.textContent = c;
                },
            });
        });
        colorRow.appendChild(colorLbl);
        colorRow.appendChild(colorPreview);
        dialog.appendChild(colorRow);
        const actions = document.createElement("div");
        actions.className = "kanban-add-column-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "kanban-add-column-cancel";
        cancel.textContent = "CANCEL";
        cancel.addEventListener("click", function () {
            hideAddDialog();
        });
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "kanban-add-column-submit";
        submit.textContent = "ADD";
        function doSubmit() {
            const v = labelInput.value.trim();
            if (!v) {
                labelInput.focus();
                return;
            }
            hideAddDialog();
            opts.onSubmit(v, chosenColor);
        }
        submit.addEventListener("click", doSubmit);
        labelInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter")
                doSubmit();
        });
        actions.appendChild(cancel);
        actions.appendChild(submit);
        dialog.appendChild(actions);
        setTimeout(function () {
            labelInput.focus();
        }, 0);
    }
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    addDialogEl = overlay;
    document.addEventListener("keydown", onDocKeyAddDialog);
}
// ── Column header context menu ─────────────────────────────────────
let columnMenuEl = null;
function hideColumnMenu() {
    if (columnMenuEl && columnMenuEl.parentNode) {
        columnMenuEl.parentNode.removeChild(columnMenuEl);
    }
    columnMenuEl = null;
    document.removeEventListener("click", onDocClickColumnMenu);
    document.removeEventListener("keydown", onDocKeyColumnMenu);
    document.removeEventListener("contextmenu", onDocContextColumnMenu);
}
function onDocClickColumnMenu() {
    hideColumnMenu();
}
function onDocKeyColumnMenu(e) {
    if (e.key === "Escape")
        hideColumnMenu();
}
function onDocContextColumnMenu() {
    hideColumnMenu();
}
function makeMenuItem(label, onClick, className, disabled) {
    const el = document.createElement("div");
    el.className = "kanban-context-item" + (className ? " " + className : "");
    if (disabled)
        el.classList.add("disabled");
    el.textContent = label;
    if (!disabled) {
        el.addEventListener("click", function (e) {
            e.stopPropagation();
            hideColumnMenu();
            onClick();
        });
    }
    return el;
}
function makeMenuSeparator() {
    const el = document.createElement("div");
    el.className = "kanban-context-separator";
    return el;
}
function showColumnMenu(opts) {
    hideColumnMenu();
    const col = findColumn(opts.columns, opts.columnId);
    if (!col)
        return;
    const menu = document.createElement("div");
    menu.className = "kanban-context-menu kanban-column-context-menu";
    menu.setAttribute("data-fulc-component", "kanban-column-context-menu");
    // RENAME
    menu.appendChild(makeMenuItem("RENAME", function () {
        if (opts.onRequestRename)
            opts.onRequestRename();
    }));
    // CHANGE COLOR
    menu.appendChild(makeMenuItem("CHANGE COLOR", function () {
        if (opts.onRequestColor) {
            opts.onRequestColor({ x: opts.x, y: opts.y });
        }
    }));
    menu.appendChild(makeMenuSeparator());
    // MOVE LEFT / MOVE RIGHT (computed against visible columns)
    const visible = visibleColumns(opts.columns);
    const visIdx = visible.findIndex((c) => c.id === opts.columnId);
    const canLeft = visIdx > 0;
    const canRight = visIdx >= 0 && visIdx < visible.length - 1;
    menu.appendChild(makeMenuItem("MOVE LEFT", function () {
        opts.onChanged(move(opts.columns, opts.columnId, -1));
    }, undefined, !canLeft));
    menu.appendChild(makeMenuItem("MOVE RIGHT", function () {
        opts.onChanged(move(opts.columns, opts.columnId, 1));
    }, undefined, !canRight));
    menu.appendChild(makeMenuSeparator());
    // RESET COLOR (builtins only)
    if (col.builtin) {
        const defaultColor = DEFAULT_COLORS[col.id] || "#6b7280";
        if (col.color.toLowerCase() !== defaultColor.toLowerCase()) {
            menu.appendChild(makeMenuItem("RESET COLOR", function () {
                opts.onChanged(setColor(opts.columns, opts.columnId, defaultColor));
            }));
        }
    }
    // HIDE / DELETE
    if (col.builtin) {
        const onlyOneVisible = visibleCount(opts.columns) <= 1;
        menu.appendChild(makeMenuItem("HIDE COLUMN", function () {
            opts.onChanged(setHidden(opts.columns, opts.columnId, true));
        }, "kanban-context-danger", onlyOneVisible));
    }
    else {
        menu.appendChild(makeMenuItem("DELETE COLUMN", function () {
            opts.onChanged(removeCustom(opts.columns, opts.columnId));
        }, "kanban-context-danger"));
    }
    document.body.appendChild(menu);
    columnMenuEl = menu;
    // Position with viewport clamping
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = opts.x;
    let top = opts.y;
    if (left + mw > vw)
        left = opts.x - mw;
    if (top + mh > vh)
        top = opts.y - mh;
    if (left < 0)
        left = 0;
    if (top < 0)
        top = 0;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.display = "block";
    setTimeout(function () {
        document.addEventListener("click", onDocClickColumnMenu);
        document.addEventListener("keydown", onDocKeyColumnMenu);
        document.addEventListener("contextmenu", onDocContextColumnMenu);
    }, 0);
}
// ── Inline rename ──────────────────────────────────────────────────
function startInlineRename(titleEl, currentLabel, onCommit) {
    const original = titleEl.textContent;
    titleEl.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "kanban-column-rename-input";
    input.value = currentLabel;
    input.maxLength = 32;
    titleEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    function finish(commit) {
        if (done)
            return;
        done = true;
        if (commit) {
            const v = input.value.trim();
            if (v && v !== currentLabel) {
                onCommit(v);
                return;
            }
        }
        titleEl.textContent = original;
    }
    input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        }
        else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
        e.stopPropagation();
    });
    input.addEventListener("blur", function () {
        finish(true);
    });
    // Don't let clicks inside the rename input bubble to the column menu
    input.addEventListener("click", function (e) {
        e.stopPropagation();
    });
}
function applyHeaderColor(headerEl, color) {
    headerEl.style.borderTop = "3px solid " + color;
    headerEl.style.borderTopLeftRadius = "4px";
    headerEl.style.borderTopRightRadius = "4px";
    // Tint background subtly with the column color
    headerEl.style.background = hexToRgba(color, 0.12);
    // Title color reflects the column color too
    const titleEl = headerEl.querySelector(".kanban-column-title");
    if (titleEl)
        titleEl.style.color = color;
}
function hexToRgba(hex, alpha) {
    if (!isHexColor(hex))
        return "rgba(255,255,255," + alpha + ")";
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}
function enhanceHeader(headerEl, column, opts) {
    applyHeaderColor(headerEl, column.color);
    headerEl.setAttribute("draggable", "true");
    headerEl.setAttribute("data-column-id", column.id);
    headerEl.classList.add("kanban-column-header-interactive");
    const titleEl = headerEl.querySelector(".kanban-column-title");
    // Click-to-rename on title only (avoid hijacking other clicks).
    if (titleEl) {
        titleEl.addEventListener("click", function (e) {
            e.stopPropagation();
            // Don't start rename if a drag is happening
            startInlineRename(titleEl, column.label, function (newLabel) {
                opts.onChanged(rename(opts.columns, column.id, newLabel));
            });
        });
    }
    headerEl.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        showColumnMenu({
            x: e.clientX,
            y: e.clientY,
            columnId: column.id,
            columns: opts.columns,
            isCrdt: opts.isCrdt,
            onChanged: opts.onChanged,
            onRequestRename() {
                if (titleEl) {
                    startInlineRename(titleEl, column.label, function (newLabel) {
                        opts.onChanged(rename(opts.columns, column.id, newLabel));
                    });
                }
            },
            onRequestColor(anchor) {
                showColorPicker({
                    x: anchor.x,
                    y: anchor.y,
                    current: column.color,
                    onChange(c) {
                        opts.onChanged(setColor(opts.columns, column.id, c));
                    },
                });
            },
        });
    });
}
const columnDragMap = new WeakMap();
function destroyColumnDrag(boardEl) {
    const handlers = columnDragMap.get(boardEl);
    if (!handlers)
        return;
    boardEl.removeEventListener("dragstart", handlers.dragstart);
    boardEl.removeEventListener("dragover", handlers.dragover);
    boardEl.removeEventListener("drop", handlers.drop);
    boardEl.removeEventListener("dragend", handlers.dragend);
    columnDragMap.delete(boardEl);
}
function initColumnDrag(boardEl, opts) {
    destroyColumnDrag(boardEl);
    let draggingColumnId = null;
    function handleDragStart(e) {
        const target = e.target;
        const header = target.closest(".kanban-column-header-interactive");
        if (!header)
            return;
        // Don't start column drag if user is dragging from inside the title's
        // rename input.
        if (e.target.tagName === "INPUT")
            return;
        const id = header.getAttribute("data-column-id");
        if (!id)
            return;
        draggingColumnId = id;
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-kanban-column", id);
            // Set a generic text payload so card-drag handlers in kanban-drag
            // ignore us — they only act on cards.
            e.dataTransfer.setData("text/plain", "column:" + id);
        }
        const colEl = header.closest(".kanban-column");
        if (colEl)
            colEl.classList.add("kanban-column-dragging");
    }
    function handleDragOver(e) {
        if (!draggingColumnId)
            return;
        const target = e.target;
        const overHeader = target.closest(".kanban-column-header-interactive");
        if (!overHeader)
            return;
        e.preventDefault();
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = "move";
        // Visually mark target column
        const allCols = boardEl.querySelectorAll(".kanban-column");
        for (let i = 0; i < allCols.length; i++) {
            allCols[i].classList.remove("kanban-column-drop-target");
        }
        const overCol = overHeader.closest(".kanban-column");
        if (overCol)
            overCol.classList.add("kanban-column-drop-target");
    }
    function handleDrop(e) {
        if (!draggingColumnId)
            return;
        const target = e.target;
        const overHeader = target.closest(".kanban-column-header-interactive");
        if (!overHeader)
            return;
        e.preventDefault();
        e.stopPropagation();
        const overId = overHeader.getAttribute("data-column-id");
        const dragId = draggingColumnId;
        draggingColumnId = null;
        if (!overId || overId === dragId) {
            cleanup();
            return;
        }
        // Build new order from current DOM positions, swapping drag→target.
        const visible = visibleColumns(opts.columns);
        const ids = visible.map((c) => c.id);
        const fromIdx = ids.indexOf(dragId);
        const toIdx = ids.indexOf(overId);
        if (fromIdx < 0 || toIdx < 0) {
            cleanup();
            return;
        }
        ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, dragId);
        opts.onChanged(reorderById(opts.columns, ids));
        cleanup();
    }
    function handleDragEnd(_e) {
        draggingColumnId = null;
        cleanup();
    }
    function cleanup() {
        const drags = boardEl.querySelectorAll(".kanban-column-dragging");
        for (let i = 0; i < drags.length; i++) {
            drags[i].classList.remove("kanban-column-dragging");
        }
        const drops = boardEl.querySelectorAll(".kanban-column-drop-target");
        for (let i = 0; i < drops.length; i++) {
            drops[i].classList.remove("kanban-column-drop-target");
        }
    }
    boardEl.addEventListener("dragstart", handleDragStart);
    boardEl.addEventListener("dragover", handleDragOver);
    boardEl.addEventListener("drop", handleDrop);
    boardEl.addEventListener("dragend", handleDragEnd);
    columnDragMap.set(boardEl, {
        dragstart: handleDragStart,
        dragover: handleDragOver,
        drop: handleDrop,
        dragend: handleDragEnd,
    });
}
// ── Public API ─────────────────────────────────────────────────────
export const KanbanColumnConfig = {
    load,
    save,
    visibleColumns,
    visibleCount,
    findColumn,
    rename,
    setColor,
    move,
    setHidden,
    removeCustom,
    reorderById,
    addCustom,
    defaultColumns,
    showColorPicker,
    hideColorPicker: hidePicker,
    showColumnMenu,
    hideColumnMenu,
    promptAddColumn,
    hideAddColumn: hideAddDialog,
    enhanceHeader,
    initColumnDrag,
    destroyColumnDrag,
    applyHeaderColor,
    BUILTIN_IDS: BUILTIN_IDS.slice(),
    DEFAULT_PALETTE: DEFAULT_PALETTE.slice(),
};
window.KanbanColumnConfig = KanbanColumnConfig;
//# sourceMappingURL=kanban-column-config.js.map