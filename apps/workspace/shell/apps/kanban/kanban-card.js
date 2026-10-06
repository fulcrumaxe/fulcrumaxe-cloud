// ── Kanban Card ──────────────────────────────────────────────────────
// Builds a single task card DOM node. Authored as `.ts` (not `.tsx`) because
// the card uses a mix of conditional logic + per-element styling and plain
// `document.createElement` reads cleaner than the equivalent JSX tree.
// Pure helpers (parseTags / parseDeps) are exported for tests.
const EPIC_COLORS = [
    "#4488ff",
    "#aa44ff",
    "#ff8844",
    "#44aaaa",
    "#ff44aa",
    "#44cc44",
    "#ffcc00",
    "#6666cc",
    "#cc66aa",
    "#88cc00",
];
/**
 * Pure helper: parse a `tags` field — may be an array already, a JSON
 * string, or empty. Always returns an array.
 */
export function parseTags(raw) {
    if (!raw)
        return [];
    if (Array.isArray(raw))
        return raw;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            /* ignore parse errors */
        }
    }
    return [];
}
/**
 * Pure helper: parse a `depends_on` field into an array of dependency ids.
 */
export function parseDeps(raw) {
    if (!raw)
        return [];
    if (Array.isArray(raw))
        return raw;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                return parsed;
        }
        catch {
            /* ignore parse errors */
        }
    }
    return [];
}
function createCard(task) {
    const card = document.createElement("div");
    card.className = "kanban-card";
    card.setAttribute("draggable", "true");
    card.setAttribute("data-task-id", String(task.id));
    card.setAttribute("tabindex", "0");
    if (task.epic_number) {
        card.setAttribute("data-epic-number", String(task.epic_number));
    }
    if (task.task_number) {
        card.setAttribute("data-task-number", String(task.task_number));
    }
    if (task.source) {
        card.setAttribute("data-source", task.source);
    }
    if (task.epic_number) {
        card.style.borderLeftColor = EPIC_COLORS[(task.epic_number - 1) % 10];
        card.style.borderLeftWidth = "3px";
    }
    else if (task.priority === "high" ||
        task.priority === "High" ||
        task.priority === "critical" ||
        task.priority === "Critical") {
        card.style.borderLeftColor = "#ff4141";
    }
    else if (task.priority === "medium" || task.priority === "Medium") {
        card.style.borderLeftColor = "#ffcc00";
    }
    else if (task.priority === "low" || task.priority === "Low") {
        card.style.borderLeftColor = "#4488ff";
    }
    const header = document.createElement("div");
    header.className = "kanban-card-header";
    if (task.epic_number) {
        const epicBadge = document.createElement("span");
        epicBadge.className = "epic-badge";
        epicBadge.textContent = "E" + task.epic_number + " #" + task.task_number;
        header.appendChild(epicBadge);
    }
    // Only show ID badge for non-epic tasks (epic badge already shows E##/T##)
    if (!task.epic_number) {
        const idBadge = document.createElement("span");
        idBadge.className = "task-id-badge";
        const idStr = String(task.id);
        idBadge.textContent = "#" + idStr.substring(idStr.length - 6);
        header.appendChild(idBadge);
    }
    if (task.task_type) {
        const typeBadge = document.createElement("span");
        typeBadge.className = "kanban-card-type";
        typeBadge.textContent = task.task_type;
        header.appendChild(typeBadge);
    }
    card.appendChild(header);
    const title = document.createElement("div");
    title.className = "kanban-card-title";
    title.textContent = task.title;
    title.title = task.title;
    card.appendChild(title);
    const tags = parseTags(task.tags);
    if (tags.length > 0) {
        const tagsContainer = document.createElement("span");
        tagsContainer.className = "kanban-card-tags";
        const maxTags = Math.min(tags.length, 3);
        for (let i = 0; i < maxTags; i++) {
            const tagEl = document.createElement("span");
            tagEl.className = "kanban-card-tag";
            tagEl.textContent = tags[i];
            tagsContainer.appendChild(tagEl);
        }
        card.appendChild(tagsContainer);
    }
    const footer = document.createElement("div");
    footer.className = "kanban-card-footer";
    if (task.has_in_progress_attempt) {
        const execDot = document.createElement("span");
        execDot.className = "exec-status exec-running";
        execDot.textContent = "\u25CF";
        footer.appendChild(execDot);
    }
    else if (task.last_attempt_failed) {
        const execDot2 = document.createElement("span");
        execDot2.className = "exec-status exec-failed";
        execDot2.textContent = "\u25CF";
        footer.appendChild(execDot2);
    }
    const deps = parseDeps(task.depends_on);
    if (deps.length > 0) {
        const depsEl = document.createElement("span");
        depsEl.className = "kanban-card-deps";
        depsEl.title = "Depends on " + deps.length + " task" + (deps.length > 1 ? "s" : "");
        depsEl.textContent = "\u27F5 " + deps.length;
        footer.appendChild(depsEl);
    }
    if (task.assignee) {
        const assigneeEl = document.createElement("span");
        assigneeEl.className = "kanban-card-assignee";
        assigneeEl.textContent = "@" + task.assignee;
        footer.appendChild(assigneeEl);
    }
    if (task.estimated_hours) {
        const hours = document.createElement("span");
        hours.className = "kanban-card-hours";
        hours.textContent = task.estimated_hours + "h";
        footer.appendChild(hours);
    }
    card.appendChild(footer);
    card._taskData = task;
    return card;
}
export const KanbanCard = {
    create(task) {
        return createCard(task);
    },
    getTaskId(cardEl) {
        return cardEl.getAttribute("data-task-id");
    },
    getData(cardEl) {
        return cardEl._taskData;
    },
};
window.KanbanCard = KanbanCard;
//# sourceMappingURL=kanban-card.js.map