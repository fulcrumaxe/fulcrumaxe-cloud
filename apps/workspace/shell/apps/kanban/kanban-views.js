// ── Kanban View Modes ─────────────────────────────────────────────────
// Three view modes: BOARD (default columns), TABLE (sortable flat rows),
// LIST (grouped by status). Switched via a small strip injected into the
// kanban filter bar. Pure helpers (status-label, tag/epic readers, cell
// value sorter) are exported for tests.
import { KanbanBoard } from "./kanban-board.js";
const COLUMNS = [
    { status: "todo", title: "TODO" },
    { status: "inprogress", title: "IN PROG" },
    { status: "inreview", title: "REVIEW" },
    { status: "done", title: "DONE" },
    { status: "cancelled", title: "CANCELLED" },
];
let _sortCol = "status";
let _sortDir = 1;
let _currentMode = "board";
// ── View Switcher Strip ───────────────────────────────────────────
// Injected into the kanban filter container — persists across renders.
let _stripEl = null;
function ensureStrip(filterEl, onSwitch) {
    if (_stripEl && _stripEl.parentNode === filterEl)
        return;
    _stripEl = document.createElement("div");
    _stripEl.className = "kv-strip";
    ["BOARD", "TABLE", "LIST"].forEach(function (label) {
        const mode = label.toLowerCase();
        const btn = document.createElement("button");
        btn.className = "kv-mode-btn" + (mode === _currentMode ? " active" : "");
        btn.textContent = label;
        btn.dataset.mode = mode;
        btn.addEventListener("click", function () {
            _currentMode = mode;
            _stripEl?.querySelectorAll(".kv-mode-btn").forEach(function (b) {
                b.classList.toggle("active", b.dataset.mode === mode);
            });
            if (onSwitch)
                onSwitch(mode);
            // Persist preference
            fetch("/api/preferences", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ "kanban-view": mode }),
            }).catch(function () {
                /* ignore */
            });
        });
        _stripEl.appendChild(btn);
    });
    // Count summary — updated by apply()
    const counts = document.createElement("span");
    counts.className = "kv-counts";
    counts.id = "kv-counts";
    _stripEl.appendChild(counts);
    // Mode label (right side)
    const modeLabel = document.createElement("span");
    modeLabel.className = "kv-mode-label";
    modeLabel.id = "kv-mode-label";
    _stripEl.appendChild(modeLabel);
    filterEl.appendChild(_stripEl);
}
function updateStrip(tasks) {
    const countsEl = document.getElementById("kv-counts");
    if (!countsEl || !tasks)
        return;
    const counts = {};
    COLUMNS.forEach(function (c) {
        counts[c.status] = 0;
    });
    tasks.forEach(function (t) {
        const s = t.status || "todo";
        counts[s] = (counts[s] || 0) + 1;
    });
    const parts = COLUMNS.filter(function (c) {
        return counts[c.status] > 0;
    }).map(function (c) {
        return c.title + " (" + counts[c.status] + ")";
    });
    countsEl.textContent = parts.join(" \u00B7 ");
    const modeEl = document.getElementById("kv-mode-label");
    if (modeEl)
        modeEl.textContent = "VIEW: " + _currentMode.toUpperCase();
}
/** Pure helper: read a task's tags as an array regardless of storage format. */
export function kvGetTags(task) {
    const t = task.tags;
    if (!t)
        return [];
    if (typeof t === "string") {
        try {
            const parsed = JSON.parse(t);
            return Array.isArray(parsed) ? parsed : t ? [t] : [];
        }
        catch {
            return t ? [t] : [];
        }
    }
    return Array.isArray(t) ? t : [];
}
/** Pure helper: compose the "E<epic>#<task>" label for a task. */
export function kvGetEpic(task) {
    if (!task.epic_number)
        return "";
    return "E" + task.epic_number + (task.task_number ? "#" + task.task_number : "");
}
/** Pure helper: map a status id to its short label. */
export function kvStatusLabel(s) {
    const map = {
        todo: "TODO",
        inprogress: "IN PROG",
        inreview: "REVIEW",
        done: "DONE",
        cancelled: "VOID",
    };
    return map[s || ""] || (s || "TODO").toUpperCase();
}
/**
 * Pure helper: extract a comparable cell value for the given column. Used
 * by the table-view sorter.
 */
export function kvCellVal(task, col) {
    if (col === "status")
        return task.status || "";
    if (col === "title")
        return (task.title || "").toLowerCase();
    if (col === "epic")
        return (task.epic_number || 0) * 1000 + (task.task_number || 0);
    if (col === "tags")
        return kvGetTags(task)[0] || "";
    if (col === "hrs")
        return task.estimated_hours || 0;
    return "";
}
// ── board ─────────────────────────────────────────────────────────
function renderBoard(el, tasks, options) {
    if (KanbanBoard)
        KanbanBoard.render(el, tasks, options || {});
}
// ── table ─────────────────────────────────────────────────────────
// Columns: STATUS(90px) | EPIC(80px) | TITLE(flex) | TAGS(150px) | HRS(52px)
function renderTable(el, tasks, options) {
    el.innerHTML = "";
    el.dataset.kanbanView = "table";
    const sorted = tasks.slice().sort(function (a, b) {
        const av = kvCellVal(a, _sortCol);
        const bv = kvCellVal(b, _sortCol);
        return av < bv ? -_sortDir : av > bv ? _sortDir : 0;
    });
    const wrap = document.createElement("div");
    wrap.className = "kv-table-wrap";
    // Header row
    const header = document.createElement("div");
    header.className = "kv-table-header";
    const cols = [
        { key: "status", label: "STATUS", cls: "kv-col-status" },
        { key: "epic", label: "EPIC", cls: "kv-col-epic" },
        { key: "title", label: "TITLE", cls: "kv-col-title" },
        { key: "tags", label: "TAGS", cls: "kv-col-tags" },
        { key: "hrs", label: "HRS", cls: "kv-col-hrs" },
    ];
    cols.forEach(function (c) {
        const cell = document.createElement("div");
        cell.className = "kv-hcell " + c.cls + (_sortCol === c.key ? " sorted" : "");
        cell.textContent =
            c.label + (_sortCol === c.key ? (_sortDir > 0 ? " \u2191" : " \u2193") : "");
        cell.addEventListener("click", function () {
            if (_sortCol === c.key) {
                _sortDir = (_sortDir * -1);
            }
            else {
                _sortCol = c.key;
                _sortDir = 1;
            }
            renderTable(el, tasks, options);
        });
        header.appendChild(cell);
    });
    wrap.appendChild(header);
    // Data rows
    const body = document.createElement("div");
    body.className = "kv-table-body";
    if (!sorted.length) {
        const empty = document.createElement("div");
        empty.className = "kv-empty";
        empty.textContent = "NO TASKS MATCH FILTERS";
        body.appendChild(empty);
    }
    sorted.forEach(function (task) {
        const row = document.createElement("div");
        row.className = "kv-row kv-row-" + (task.status || "todo");
        row._taskData = task;
        // STATUS cell — badge + left accent
        const statusCell = document.createElement("div");
        statusCell.className = "kv-cell kv-col-status";
        const badge = document.createElement("span");
        badge.className = "kv-status-badge kv-status-" + (task.status || "todo");
        badge.textContent = kvStatusLabel(task.status);
        statusCell.appendChild(badge);
        // EPIC cell
        const epicCell = document.createElement("div");
        epicCell.className = "kv-cell kv-col-epic";
        const epicRef = kvGetEpic(task);
        epicCell.textContent = epicRef || "\u2014";
        // TITLE cell — two lines: title + type badge
        const titleCell = document.createElement("div");
        titleCell.className = "kv-cell kv-col-title";
        const titleLine = document.createElement("div");
        titleLine.className = "kv-title-primary";
        titleLine.textContent = task.title || "(untitled)";
        const typeLine = document.createElement("div");
        typeLine.className = "kv-title-secondary";
        const rawType = task.type;
        typeLine.textContent = rawType ? rawType.toUpperCase() : "";
        titleCell.appendChild(titleLine);
        titleCell.appendChild(typeLine);
        // TAGS cell
        const tagsCell = document.createElement("div");
        tagsCell.className = "kv-cell kv-col-tags";
        const tags = kvGetTags(task);
        tagsCell.textContent = tags.length ? tags.slice(0, 3).join(", ") : "\u2014";
        // HRS cell
        const hrsCell = document.createElement("div");
        hrsCell.className = "kv-cell kv-col-hrs";
        hrsCell.textContent = task.estimated_hours ? task.estimated_hours + "H" : "\u2014";
        row.appendChild(statusCell);
        row.appendChild(epicCell);
        row.appendChild(titleCell);
        row.appendChild(tagsCell);
        row.appendChild(hrsCell);
        if (options && options.onCardClick) {
            row.addEventListener("click", function () {
                options.onCardClick(task);
            });
        }
        body.appendChild(row);
    });
    wrap.appendChild(body);
    el.appendChild(wrap);
}
// ── list ──────────────────────────────────────────────────────────
// Grouped by status. Two-line items: title (primary) + epic/tags (secondary).
function renderList(el, tasks, options) {
    el.innerHTML = "";
    el.dataset.kanbanView = "list";
    const wrap = document.createElement("div");
    wrap.className = "kv-list-wrap";
    COLUMNS.forEach(function (col) {
        const group = tasks.filter(function (t) {
            return (t.status || "todo") === col.status;
        });
        if (!group.length)
            return;
        const section = document.createElement("div");
        section.className = "kv-list-section kv-list-" + col.status;
        // Section header with inline count
        const hdr = document.createElement("div");
        hdr.className = "kv-list-hdr";
        const hdrTitle = document.createElement("span");
        hdrTitle.className = "kv-list-hdr-title";
        hdrTitle.textContent = col.title;
        const hdrCount = document.createElement("span");
        hdrCount.className = "kv-list-hdr-count";
        hdrCount.textContent = "(" + group.length + ")";
        hdr.appendChild(hdrTitle);
        hdr.appendChild(hdrCount);
        section.appendChild(hdr);
        group.forEach(function (task) {
            const item = document.createElement("div");
            item.className = "kv-list-item";
            item._taskData = task;
            // Line 1: title (accent)
            const line1 = document.createElement("div");
            line1.className = "kv-list-primary";
            line1.textContent = task.title || "(untitled)";
            // Line 2: epic ref + tags (muted)
            const line2 = document.createElement("div");
            line2.className = "kv-list-secondary";
            const parts = [];
            const ref = kvGetEpic(task);
            if (ref)
                parts.push(ref);
            const tags = kvGetTags(task);
            if (tags.length)
                parts.push(tags.slice(0, 2).join(" \u00B7 "));
            if (task.estimated_hours)
                parts.push(task.estimated_hours + "H");
            line2.textContent = parts.join("  \u00B7  ") || "\u00a0";
            item.appendChild(line1);
            item.appendChild(line2);
            if (options && options.onCardClick) {
                item.addEventListener("click", function () {
                    options.onCardClick(task);
                });
            }
            section.appendChild(item);
        });
        wrap.appendChild(section);
    });
    if (!wrap.children.length) {
        const empty = document.createElement("div");
        empty.className = "kv-empty";
        empty.textContent = "NO TASKS";
        wrap.appendChild(empty);
    }
    el.appendChild(wrap);
}
// ── Public API ────────────────────────────────────────────────────
export const KanbanViews = {
    ensureStrip,
    updateStrip,
    setMode(mode) {
        _currentMode = mode;
        if (_stripEl) {
            _stripEl.querySelectorAll(".kv-mode-btn").forEach(function (b) {
                b.classList.toggle("active", b.dataset.mode === mode);
            });
            const ml = document.getElementById("kv-mode-label");
            if (ml)
                ml.textContent = "VIEW: " + mode.toUpperCase();
        }
    },
    currentMode() {
        return _currentMode;
    },
    apply(boardEl, mode, tasks, options) {
        _currentMode = mode || "board";
        boardEl.dataset.kanbanView = _currentMode;
        boardEl.style.opacity = "0";
        requestAnimationFrame(function () {
            if (_currentMode === "table") {
                renderTable(boardEl, tasks, options);
            }
            else if (_currentMode === "list") {
                renderList(boardEl, tasks, options);
            }
            else {
                renderBoard(boardEl, tasks, options);
            }
            boardEl.style.transition = "opacity 0.15s";
            boardEl.style.opacity = "1";
            updateStrip(tasks);
        });
    },
    destroyStrip() {
        if (_stripEl && _stripEl.parentNode)
            _stripEl.parentNode.removeChild(_stripEl);
        _stripEl = null;
    },
};
window.KanbanViews = KanbanViews;
//# sourceMappingURL=kanban-views.js.map