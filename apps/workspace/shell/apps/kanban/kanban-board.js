// ── Kanban Board ────────────────────────────────────────────────────
// Renders the kanban columns and populates them with cards. Columns are
// dynamic — when `options.columns` is supplied (a `KanbanColumn[]` from
// KanbanColumnConfig), the board renders those columns honoring custom
// labels, colors, ordering, and hidden state. Otherwise it falls back
// to the 5 built-in columns matching the SQLite tasks.status CHECK
// constraint.
import { KanbanCard } from "./kanban-card.js";
import { KanbanDrag } from "./kanban-drag.js";
const BUILTIN_COLUMN_DEFS = [
    { status: "todo", title: "TODO", builtin: true },
    { status: "inprogress", title: "IN PROG", builtin: true },
    { status: "inreview", title: "REVIEW", builtin: true },
    { status: "done", title: "DONE", builtin: true },
    { status: "cancelled", title: "CANCELLED", builtin: true },
];
function getColumnDefs(_isCrdt, columns) {
    if (Array.isArray(columns) && columns.length > 0) {
        const defs = [];
        for (let i = 0; i < columns.length; i++) {
            const c = columns[i];
            if (!c || typeof c.id !== "string" || c.hidden)
                continue;
            defs.push({
                status: c.id,
                title: typeof c.label === "string" && c.label ? c.label : c.id.toUpperCase(),
                color: typeof c.color === "string" ? c.color : undefined,
                builtin: !!c.builtin,
            });
        }
        if (defs.length > 0)
            return defs;
    }
    return BUILTIN_COLUMN_DEFS.map((c) => ({ ...c }));
}
function groupTasks(tasks) {
    const groups = {};
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const key = task.status || "todo";
        if (!groups[key]) {
            groups[key] = [];
        }
        groups[key].push(task);
    }
    return groups;
}
function hexToRgba(hex, alpha) {
    if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return "rgba(255,255,255," + alpha + ")";
    }
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}
function createColumnEl(colDef) {
    const col = document.createElement("div");
    col.className = "kanban-column";
    col.setAttribute("data-status", colDef.status);
    const header = document.createElement("div");
    header.className = "kanban-column-header";
    const title = document.createElement("span");
    title.className = "kanban-column-title";
    title.textContent = colDef.title;
    const count = document.createElement("span");
    count.className = "kanban-column-count";
    count.textContent = "(0)";
    header.appendChild(title);
    header.appendChild(count);
    // Apply column color if provided.
    if (colDef.color) {
        header.style.borderTop = "3px solid " + colDef.color;
        header.style.borderTopLeftRadius = "4px";
        header.style.borderTopRightRadius = "4px";
        header.style.background = hexToRgba(colDef.color, 0.12);
        title.style.color = colDef.color;
    }
    const body = document.createElement("div");
    body.className = "kanban-column-body";
    const footer = document.createElement("div");
    footer.className = "kanban-column-footer";
    const addBtn = document.createElement("button");
    addBtn.className = "kanban-add-btn";
    addBtn.textContent = "+ Add";
    footer.appendChild(addBtn);
    col.appendChild(header);
    col.appendChild(body);
    col.appendChild(footer);
    return col;
}
function setupQuickAdd(footer, status, options) {
    const btn = footer.querySelector(".kanban-add-btn");
    if (!btn)
        return;
    btn.addEventListener("click", function () {
        btn.style.display = "none";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "kanban-quick-add-input";
        input.placeholder = "Task title...";
        footer.appendChild(input);
        input.focus();
        function cleanup() {
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
            btn.style.display = "";
        }
        input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
                const val = input.value.trim();
                if (val && options && options.onQuickAdd) {
                    options.onQuickAdd(status, val);
                }
                cleanup();
            }
            else if (e.key === "Escape") {
                cleanup();
            }
        });
        input.addEventListener("blur", function () {
            cleanup();
        });
    });
}
function populateColumn(col, tasks, options) {
    const body = col.querySelector(".kanban-column-body");
    const countEl = col.querySelector(".kanban-column-count");
    if (!body)
        return;
    body.innerHTML = "";
    const taskList = tasks || [];
    if (countEl)
        countEl.textContent = "(" + taskList.length + ")";
    if (taskList.length === 0) {
        const empty = document.createElement("div");
        empty.className = "kanban-empty-hint";
        empty.textContent = "No tasks";
        body.appendChild(empty);
        return;
    }
    const onClick = options && options.onCardClick ? options.onCardClick : null;
    for (let i = 0; i < taskList.length; i++) {
        if (KanbanCard && KanbanCard.create) {
            const card = KanbanCard.create(taskList[i]);
            if (card) {
                if (onClick) {
                    ((data) => {
                        card.addEventListener("click", function () {
                            onClick(data);
                        });
                    })(taskList[i]);
                }
                body.appendChild(card);
            }
        }
    }
}
function createAddColumnTrailer(onAddColumn) {
    const wrap = document.createElement("div");
    wrap.className = "kanban-column-trailer";
    const btn = document.createElement("button");
    btn.className = "kanban-add-column-btn";
    btn.type = "button";
    btn.textContent = "+ COLUMN";
    btn.title = "Add a new column";
    btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        onAddColumn();
    });
    wrap.appendChild(btn);
    return wrap;
}
function render(container, tasks, options) {
    const opts = options || {};
    const colDefs = getColumnDefs(opts.isCrdt, opts.columns);
    const groups = groupTasks(tasks || []);
    container.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "kanban-columns";
    for (let i = 0; i < colDefs.length; i++) {
        const colDef = colDefs[i];
        const colEl = createColumnEl(colDef);
        populateColumn(colEl, groups[colDef.status], opts);
        const footer = colEl.querySelector(".kanban-column-footer");
        if (footer)
            setupQuickAdd(footer, colDef.status, opts);
        if (opts.onColumnRendered) {
            opts.onColumnRendered(colEl, colDef.status);
        }
        wrapper.appendChild(colEl);
    }
    if (opts.onAddColumn) {
        wrapper.appendChild(createAddColumnTrailer(opts.onAddColumn));
    }
    container.appendChild(wrapper);
}
function cardDataEqual(a, b) {
    if (!a)
        return false;
    if (a === b)
        return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
/**
 * Invalidate any cached drag-start card rects for `container`, if a drag is
 * in progress. Called whenever a column's DOM is structurally rebuilt (card
 * added/removed/reordered) so an active drag doesn't keep using stale
 * positions for cards it didn't touch — see review on D#240 P4.4: the drag
 * rect cache is only self-correcting for elements it *replaces* (a fresh
 * getBoundingClientRect() runs on cache-miss), not for untouched sibling
 * cards whose on-screen position shifted because of a neighboring
 * add/remove. `KanbanDrag.invalidateCache()` is a no-op when there's no
 * active drag on `container`, so this is safe to call unconditionally.
 */
function invalidateDragCache(container) {
    if (KanbanDrag && KanbanDrag.invalidateCache) {
        KanbanDrag.invalidateCache(container);
    }
}
/**
 * Patch a single column's cards in place when the set/order of task ids is
 * unchanged — only cards whose data actually differs get their DOM node
 * replaced, and unchanged cards are left untouched entirely. Falls back to
 * a full `populateColumn` rebuild whenever the update is structural (a card
 * was added, removed, or reordered within the column), since patching
 * in-place can't express those changes without extra bookkeeping.
 */
function patchColumn(col, tasks, options, container) {
    const body = col.querySelector(".kanban-column-body");
    const countEl = col.querySelector(".kanban-column-count");
    if (!body)
        return;
    const taskList = tasks || [];
    const existingCards = Array.from(body.querySelectorAll(".kanban-card"));
    // Structural cases (empty column either way, or a differing id/order)
    // require the full rebuild path. Only invalidate the drag cache when a
    // card count actually changed — an empty column staying empty rebuilds
    // its "No tasks" hint on every call (pre-existing behavior) but touches
    // no `.kanban-card` element, so there's nothing for a drag to have
    // stale rects about.
    if (taskList.length === 0 || existingCards.length !== taskList.length) {
        if (existingCards.length !== taskList.length) {
            invalidateDragCache(container);
        }
        populateColumn(col, tasks, options);
        return;
    }
    for (let i = 0; i < taskList.length; i++) {
        if (existingCards[i].getAttribute("data-task-id") !== String(taskList[i].id)) {
            invalidateDragCache(container);
            populateColumn(col, tasks, options);
            return;
        }
    }
    // Same cards, same order — patch in place, skipping cards whose data
    // hasn't changed at all.
    if (countEl)
        countEl.textContent = "(" + taskList.length + ")";
    const onClick = options && options.onCardClick ? options.onCardClick : null;
    let anyCardReplaced = false;
    for (let i = 0; i < taskList.length; i++) {
        const task = taskList[i];
        const existing = existingCards[i];
        if (cardDataEqual(existing._taskData, task)) {
            continue;
        }
        if (!KanbanCard || !KanbanCard.create)
            continue;
        const newCard = KanbanCard.create(task);
        if (onClick) {
            ((data) => {
                newCard.addEventListener("click", function () {
                    onClick(data);
                });
            })(task);
        }
        // dom-insert-ok: newCard is KanbanCard.create(task), which always returns a card element
        existing.replaceWith(newCard);
        anyCardReplaced = true;
    }
    // A content-only replace can still change the card's height (e.g.
    // `.kanban-card-title` line-clamps rather than truncating at a fixed
    // height, and `.kanban-card-tags` only exists when tags are present) —
    // that shifts every sibling card below it in the column, so any drag rect
    // cache needs to be dropped just like the structural-rebuild cases above.
    if (anyCardReplaced) {
        invalidateDragCache(container);
    }
}
function update(container, tasks, options) {
    const opts = options || {};
    const colDefs = getColumnDefs(opts.isCrdt, opts.columns);
    const groups = groupTasks(tasks || []);
    for (let i = 0; i < colDefs.length; i++) {
        const colDef = colDefs[i];
        const colEl = container.querySelector('.kanban-column[data-status="' + colDef.status + '"]');
        if (colEl) {
            patchColumn(colEl, groups[colDef.status], opts, container);
        }
    }
}
function getColumn(container, status) {
    return container.querySelector('.kanban-column[data-status="' + status + '"]');
}
function getStatuses(isCrdt, columns) {
    const colDefs = getColumnDefs(isCrdt, columns);
    const result = [];
    for (let i = 0; i < colDefs.length; i++) {
        result.push(colDefs[i].status);
    }
    return result;
}
export const KanbanBoard = {
    render,
    update,
    getColumn,
    getStatuses,
};
window.KanbanBoard = KanbanBoard;
//# sourceMappingURL=kanban-board.js.map