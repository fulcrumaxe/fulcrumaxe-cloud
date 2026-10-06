// ── Kanban Filter Bar ───────────────────────────────────────────────
// Hosts the project selector, directory picker, and the six filter
// dropdowns (status, priority, assignee, tag, epic, search). The pure
// helpers — saveFilters / loadFilters / parseFilters / storageKey — are
// exported so tests can cover the 90% pure-logic tier independently of
// the DOM.
// FULCModals is accessed via `window.FULCModals` (declared globally in
// fulc.d.ts) instead of a static core/* import so vitest's vite
// import-analysis doesn't choke when tests load this module.
import { KanbanConfirm } from "./kanban-confirm.js";
import { KanbanProjectModal } from "./kanban-project-modal.js";
// ── Constants ────────────────────────────────────────────────────
const STORAGE_KEY = "fulc-kanban-filters";
const SELECTED_PROJECT_KEY = "kanban-selected-project";
/** Default (empty) filter state — mirrors KanbanFilterState but with sane zeros. */
export function emptyFilters() {
    return { search: "", status: "", epicNumber: null, priority: "", assignee: "", tag: "" };
}
// ── Pure-logic helpers (tested directly) ─────────────────────────
/**
 * Build the localStorage key used for a project's saved filters.
 * Kept as a one-liner so the key format has one test-covered home.
 */
export function filterStorageKey() {
    return STORAGE_KEY;
}
/**
 * Pure helper: given the raw string value read from a status / priority
 * `<select>`, and the raw epic value, produce a KanbanFilterState. Any
 * `null`/`undefined` element is treated as its empty equivalent.
 */
export function parseFilters(searchVal, statusVal, epicVal, priorityVal, assigneeVal, tagVal) {
    return {
        search: searchVal || "",
        status: statusVal || "",
        epicNumber: epicVal ? parseInt(epicVal, 10) : null,
        priority: priorityVal || "",
        assignee: assigneeVal || "",
        tag: tagVal || "",
    };
}
/**
 * Pure helper: write a filter state to the `all-projects` persistence blob
 * in localStorage. Non-throwing — storage errors are swallowed.
 */
export function saveFilters(projectId, filters) {
    if (!projectId)
        return;
    try {
        const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        all[String(projectId)] = filters;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    }
    catch {
        /* ignore */
    }
}
/**
 * Pure helper: read the saved filters for a project, or `null` when
 * storage is empty / malformed.
 */
export function loadFilters(projectId) {
    if (!projectId)
        return null;
    try {
        const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return all[String(projectId)] || null;
    }
    catch {
        return null;
    }
}
/**
 * Pure helper: derive the short directory label shown on the DIR button.
 * Returns `{ text, title }` tuple.
 */
export function dirBtnLabel(project) {
    const dir = project && project.default_agent_working_dir;
    if (dir) {
        const short = dir.split("/").filter(Boolean).pop() || dir;
        return { text: short, title: "Project directory: " + dir + " (click to change)" };
    }
    return { text: "DIR", title: "Set project directory (for epic discovery)" };
}
// ── DOM helpers ──────────────────────────────────────────────────
function populateProjects(selectEl, projects) {
    // Remove all options except the first default one
    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }
    for (let i = 0; i < projects.length; i++) {
        const opt = document.createElement("option");
        opt.value = String(projects[i].id);
        opt.textContent = projects[i].name || projects[i].title || String(projects[i].id);
        selectEl.appendChild(opt);
    }
}
function populateEpics(selectEl, epics) {
    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }
    for (let i = 0; i < epics.length; i++) {
        const opt = document.createElement("option");
        opt.value = String(epics[i].epic_number);
        opt.textContent = "Epic " + epics[i].epic_number + ": " + (epics[i].title || "");
        selectEl.appendChild(opt);
    }
}
function populateAssignees(selectEl, assignees) {
    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }
    for (let i = 0; i < assignees.length; i++) {
        const opt = document.createElement("option");
        opt.value = assignees[i];
        opt.textContent = assignees[i];
        selectEl.appendChild(opt);
    }
}
function populateTags(selectEl, tags) {
    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }
    for (let i = 0; i < tags.length; i++) {
        const opt = document.createElement("option");
        opt.value = tags[i];
        opt.textContent = tags[i];
        selectEl.appendChild(opt);
    }
}
function getBar(container) {
    if (!container)
        return null;
    return container.querySelector(".kanban-filter-bar");
}
function getFiltersFromBar(bar) {
    const searchInput = bar.querySelector(".kanban-search-input");
    const statusSelect = bar.querySelector(".kanban-status-filter");
    const epicSelect = bar.querySelector(".kanban-epic-filter");
    const prioritySelect = bar.querySelector(".kanban-priority-filter");
    const assigneeSelect = bar.querySelector(".kanban-assignee-filter");
    const tagSelect = bar.querySelector(".kanban-tag-filter");
    return parseFilters(searchInput?.value, statusSelect?.value, epicSelect?.value, prioritySelect?.value, assigneeSelect?.value, tagSelect?.value);
}
function updateDirBtnLabel(btn, project) {
    const { text, title } = dirBtnLabel(project);
    btn.textContent = text;
    btn.title = title;
}
function restoreFiltersInto(container, filters) {
    if (!container || !filters)
        return;
    const bar = getBar(container);
    if (!bar)
        return;
    const statusSel = bar.querySelector(".kanban-status-filter");
    const prioritySel = bar.querySelector(".kanban-priority-filter");
    const assigneeSel = bar.querySelector(".kanban-assignee-filter");
    const tagSel = bar.querySelector(".kanban-tag-filter");
    const epicSel = bar.querySelector(".kanban-epic-filter");
    const searchInput = bar.querySelector(".kanban-search-input");
    if (statusSel && filters.status)
        statusSel.value = filters.status;
    if (prioritySel && filters.priority)
        prioritySel.value = filters.priority;
    if (assigneeSel && filters.assignee)
        assigneeSel.value = filters.assignee;
    if (tagSel && filters.tag)
        tagSel.value = filters.tag;
    if (epicSel && filters.epicNumber)
        epicSel.value = String(filters.epicNumber);
    if (searchInput && filters.search)
        searchInput.value = filters.search;
}
// ── DOM builder ──────────────────────────────────────────────────
function buildFilterBar(container, options) {
    const bar = document.createElement("div");
    bar.className = "kanban-filter-bar";
    // Project selector
    const projectSelect = document.createElement("select");
    projectSelect.className = "kanban-project-select";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Select Project...";
    projectSelect.appendChild(defaultOpt);
    populateProjects(projectSelect, options.projects || []);
    bar.appendChild(projectSelect);
    // New Project button
    const newProjectBtn = document.createElement("button");
    newProjectBtn.className = "kanban-new-project-btn";
    newProjectBtn.textContent = "+ New";
    newProjectBtn.addEventListener("click", function () {
        if (KanbanProjectModal) {
            KanbanProjectModal.show({
                container: bar.closest("[tabindex]") || document.body,
                onCreated(project) {
                    if (options.projects)
                        options.projects.push(project);
                    populateProjects(projectSelect, options.projects || []);
                    projectSelect.value = String(project.id);
                    localStorage.setItem(SELECTED_PROJECT_KEY, String(project.id));
                    if (options.onProjectChange)
                        options.onProjectChange(project);
                },
            });
        }
    });
    bar.appendChild(newProjectBtn);
    // Set Directory button (opens file manager picker for current project)
    const setDirBtn = document.createElement("button");
    setDirBtn.className = "kanban-set-dir-btn";
    setDirBtn.textContent = "DIR";
    setDirBtn.title = "Set project directory (for epic discovery)";
    setDirBtn.style.display = "none";
    setDirBtn.addEventListener("click", function () {
        const selectedId = projectSelect.value;
        if (!selectedId)
            return;
        let project = null;
        const projects = options.projects || [];
        for (let i = 0; i < projects.length; i++) {
            if (String(projects[i].id) === selectedId) {
                project = projects[i];
                break;
            }
        }
        if (!project)
            return;
        const proj = project;
        if (window.FULCFilePicker) {
            window.FULCFilePicker.pickDirectory({
                title: "Set Directory for " + (proj.name || "Project"),
                startPath: proj.default_agent_working_dir || "/home",
                onSelect(path) {
                    // Update project via API
                    fetch("/api/projects/" + proj.id, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ directory_path: path }),
                    })
                        .then((r) => r.json())
                        .then((j) => {
                        if (j.success && j.data) {
                            // Update local project object
                            proj.default_agent_working_dir = j.data.default_agent_working_dir;
                            updateDirBtnLabel(setDirBtn, proj);
                            // Trigger project reload to pick up new epics
                            if (options.onProjectChange)
                                options.onProjectChange(proj);
                        }
                    });
                },
                onCancel() {
                    /* nothing */
                },
            });
        }
    });
    bar.appendChild(setDirBtn);
    // Delete Project button
    const delProjectBtn = document.createElement("button");
    delProjectBtn.className = "kanban-del-project-btn";
    delProjectBtn.textContent = "\u2716";
    delProjectBtn.title = "Delete project";
    delProjectBtn.style.display = "none";
    delProjectBtn.addEventListener("click", function () {
        const selectedId = projectSelect.value;
        if (!selectedId)
            return;
        let project = null;
        const projects = options.projects || [];
        for (let i = 0; i < projects.length; i++) {
            if (String(projects[i].id) === selectedId) {
                project = projects[i];
                break;
            }
        }
        if (!project)
            return;
        const proj = project;
        const confirmContainer = bar.closest("[tabindex]") || document.body;
        if (KanbanConfirm) {
            KanbanConfirm.show({
                message: 'Delete project "' +
                    (proj.name || proj.id) +
                    '"? All tasks in this project will be permanently removed.',
                container: confirmContainer,
                onConfirm() {
                    const isCrdt = proj.storage_mode === "crdt_offline" ||
                        proj.storage_mode === "crdt_collaborative";
                    // Always delete from SQLite (project list comes from SQLite).
                    // Also delete from CRDT if the project uses CRDT storage.
                    const sqliteDelete = fetch("/api/projects/" + proj.id, { method: "DELETE" })
                        .then((r) => r.json())
                        .catch(() => ({ success: false }));
                    const crdtDelete = isCrdt
                        ? fetch("/api/crdt/projects/" + proj.id, { method: "DELETE" })
                            .then((r) => r.json())
                            .catch(() => ({ success: true }))
                        : Promise.resolve({ success: true });
                    Promise.all([sqliteDelete, crdtDelete]).then(function (results) {
                        const sqliteResult = results[0];
                        if (sqliteResult.success) {
                            // Remove from local list
                            if (options.projects) {
                                for (let i = options.projects.length - 1; i >= 0; i--) {
                                    if (String(options.projects[i].id) === selectedId) {
                                        options.projects.splice(i, 1);
                                        break;
                                    }
                                }
                            }
                            populateProjects(projectSelect, options.projects || []);
                            projectSelect.value = "";
                            localStorage.removeItem(SELECTED_PROJECT_KEY);
                            onProjectSelectChange();
                            if (options.onProjectChange)
                                options.onProjectChange(null);
                            if (window.FULCModals && window.FULCModals.toast) {
                                window.FULCModals.toast("Project deleted");
                            }
                        }
                        else {
                            const msg = sqliteResult.message || "Failed to delete project";
                            if (window.FULCModals && window.FULCModals.toast) {
                                window.FULCModals.toast(msg);
                            }
                        }
                    });
                },
            });
        }
    });
    bar.appendChild(delProjectBtn);
    // Update dir/delete button visibility when project changes
    function onProjectSelectChange() {
        const val = projectSelect.value;
        if (!val) {
            setDirBtn.style.display = "none";
            delProjectBtn.style.display = "none";
            return;
        }
        const projects = options.projects || [];
        for (let i = 0; i < projects.length; i++) {
            if (String(projects[i].id) === val) {
                setDirBtn.style.display = "";
                delProjectBtn.style.display = "";
                updateDirBtnLabel(setDirBtn, projects[i]);
                return;
            }
        }
        setDirBtn.style.display = "none";
        delProjectBtn.style.display = "none";
    }
    // Search input
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "kanban-search-input";
    searchInput.placeholder = "Search tasks...";
    bar.appendChild(searchInput);
    // Status filter
    const statusSelect = document.createElement("select");
    statusSelect.className = "kanban-status-filter";
    const statuses = [
        { value: "", label: "All Statuses" },
        { value: "todo", label: "TODO" },
        { value: "inprogress", label: "IN PROG" },
        { value: "inreview", label: "REVIEW" },
        { value: "done", label: "DONE" },
        { value: "cancelled", label: "CANCELLED" },
    ];
    for (let i = 0; i < statuses.length; i++) {
        const opt = document.createElement("option");
        opt.value = statuses[i].value;
        opt.textContent = statuses[i].label;
        statusSelect.appendChild(opt);
    }
    bar.appendChild(statusSelect);
    // Priority filter
    const prioritySelect = document.createElement("select");
    prioritySelect.className = "kanban-priority-filter";
    const priorities = [
        { value: "", label: "All Priorities" },
        { value: "high", label: "High" },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
    ];
    for (let pi = 0; pi < priorities.length; pi++) {
        const popt = document.createElement("option");
        popt.value = priorities[pi].value;
        popt.textContent = priorities[pi].label;
        prioritySelect.appendChild(popt);
    }
    bar.appendChild(prioritySelect);
    // Assignee filter
    const assigneeSelect = document.createElement("select");
    assigneeSelect.className = "kanban-assignee-filter";
    const assigneeDefault = document.createElement("option");
    assigneeDefault.value = "";
    assigneeDefault.textContent = "All Assignees";
    assigneeSelect.appendChild(assigneeDefault);
    bar.appendChild(assigneeSelect);
    // Tag filter
    const tagSelect = document.createElement("select");
    tagSelect.className = "kanban-tag-filter";
    const tagDefault = document.createElement("option");
    tagDefault.value = "";
    tagDefault.textContent = "All Tags";
    tagSelect.appendChild(tagDefault);
    bar.appendChild(tagSelect);
    // Epic filter
    const epicSelect = document.createElement("select");
    epicSelect.className = "kanban-epic-filter";
    const allEpicsOpt = document.createElement("option");
    allEpicsOpt.value = "";
    allEpicsOpt.textContent = "All Epics";
    epicSelect.appendChild(allEpicsOpt);
    populateEpics(epicSelect, options.epics || []);
    bar.appendChild(epicSelect);
    container.appendChild(bar);
    // Restore project from localStorage
    const savedProjectId = localStorage.getItem(SELECTED_PROJECT_KEY);
    if (savedProjectId) {
        projectSelect.value = savedProjectId;
        if (projectSelect.value === savedProjectId && options.onProjectChange) {
            const projects = options.projects || [];
            for (let p = 0; p < projects.length; p++) {
                if (String(projects[p].id) === savedProjectId) {
                    onProjectSelectChange();
                    options.onProjectChange(projects[p]);
                    break;
                }
            }
        }
    }
    // Event listeners
    projectSelect.addEventListener("change", function () {
        const val = projectSelect.value;
        if (val) {
            localStorage.setItem(SELECTED_PROJECT_KEY, val);
        }
        else {
            localStorage.removeItem(SELECTED_PROJECT_KEY);
        }
        onProjectSelectChange();
        if (options.onProjectChange) {
            let selected = null;
            const projects = options.projects || [];
            for (let p = 0; p < projects.length; p++) {
                if (String(projects[p].id) === val) {
                    selected = projects[p];
                    break;
                }
            }
            options.onProjectChange(selected);
        }
    });
    searchInput.addEventListener("input", function () {
        if (options.onFilterChange) {
            options.onFilterChange(getFiltersFromBar(bar));
        }
    });
    statusSelect.addEventListener("change", function () {
        if (options.onFilterChange) {
            options.onFilterChange(getFiltersFromBar(bar));
        }
    });
    epicSelect.addEventListener("change", function () {
        if (options.onFilterChange) {
            options.onFilterChange(getFiltersFromBar(bar));
        }
    });
    prioritySelect.addEventListener("change", function () {
        if (options.onFilterChange) {
            options.onFilterChange(getFiltersFromBar(bar));
        }
    });
    assigneeSelect.addEventListener("change", function () {
        if (options.onFilterChange) {
            options.onFilterChange(getFiltersFromBar(bar));
        }
    });
    tagSelect.addEventListener("change", function () {
        if (options.onFilterChange) {
            options.onFilterChange(getFiltersFromBar(bar));
        }
    });
}
// ── Public API ──────────────────────────────────────────────────
export const KanbanFilter = {
    render(container, options) {
        buildFilterBar(container, options);
    },
    setProject(container, projectId) {
        const bar = getBar(container);
        if (!bar)
            return;
        const select = bar.querySelector(".kanban-project-select");
        if (!select)
            return;
        select.value = String(projectId);
        localStorage.setItem(SELECTED_PROJECT_KEY, String(projectId));
    },
    getFilters(container) {
        const bar = getBar(container);
        if (!bar)
            return emptyFilters();
        return getFiltersFromBar(bar);
    },
    updateProjects(container, projects) {
        const bar = getBar(container);
        if (!bar)
            return;
        const select = bar.querySelector(".kanban-project-select");
        if (!select)
            return;
        const current = select.value;
        populateProjects(select, projects);
        if (current)
            select.value = current;
    },
    updateEpics(container, epics) {
        const bar = getBar(container);
        if (!bar)
            return;
        const select = bar.querySelector(".kanban-epic-filter");
        if (!select)
            return;
        const current = select.value;
        populateEpics(select, epics);
        if (current)
            select.value = current;
    },
    updateAssignees(container, assignees) {
        const bar = getBar(container);
        if (!bar)
            return;
        const select = bar.querySelector(".kanban-assignee-filter");
        if (!select)
            return;
        const current = select.value;
        populateAssignees(select, assignees);
        if (current)
            select.value = current;
    },
    updateTags(container, tags) {
        const bar = getBar(container);
        if (!bar)
            return;
        const select = bar.querySelector(".kanban-tag-filter");
        if (!select)
            return;
        const current = select.value;
        populateTags(select, tags);
        if (current)
            select.value = current;
    },
    saveFilters,
    loadFilters,
    restoreFilters: restoreFiltersInto,
};
window.KanbanFilter = KanbanFilter;
//# sourceMappingURL=kanban-filter.js.map