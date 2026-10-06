// Per-app configuration and preferences storage.
//
// Dual-storage strategy: values live in namespaced localStorage (fast,
// synchronous reads) and are synced to the server (persistent across
// devices/profiles) on every write.
//
// Hot-reload: any call to `set()` or `importConfig()` fires a
// `"config-changed"` event on the shared `events` bus so the running app
// can react without a full restart.
import { requireAppId, debugLog } from "./internal.js";
import { events } from "./events.js";
const CONFIG_KEY_PREFIX = "fulc:config:";
const CONFIG_CHANGED_EVENT = "config-changed";
function namespace() {
    return CONFIG_KEY_PREFIX + requireAppId("config.*") + ":";
}
function ls() {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    }
    catch {
        return null;
    }
}
const memFallback = new Map();
function readRaw(k) {
    const store = ls();
    if (store)
        return store.getItem(k);
    return memFallback.get(k) ?? null;
}
function writeRaw(k, v) {
    const store = ls();
    if (store)
        store.setItem(k, v);
    else
        memFallback.set(k, v);
}
function listKeys(prefix) {
    const store = ls();
    const out = [];
    if (store) {
        for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k && k.startsWith(prefix))
                out.push(k.slice(prefix.length));
        }
    }
    else {
        for (const k of memFallback.keys()) {
            if (k.startsWith(prefix))
                out.push(k.slice(prefix.length));
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Server sync
// ---------------------------------------------------------------------------
async function fetchServerConfig(appId) {
    try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/config`, {
            credentials: "same-origin",
        });
        if (!res.ok)
            return null;
        const body = await res.json();
        // Handle ApiResponse<{ ... }> envelope
        const data = body["data"];
        return data ?? body;
    }
    catch {
        return null;
    }
}
async function pushServerConfig(appId, cfg) {
    try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/config`, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cfg),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function getAllFromStorage() {
    const ns = namespace();
    const result = {};
    for (const key of listKeys(ns)) {
        const raw = readRaw(ns + key);
        if (raw !== null) {
            try {
                result[key] = JSON.parse(raw);
            }
            catch {
                result[key] = raw;
            }
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Settings-panel helpers
// ---------------------------------------------------------------------------
function buildFieldInput(key, field, currentValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "fulc-config-field";
    const label = document.createElement("label");
    label.htmlFor = `fulc-config-${key}`;
    label.textContent = field.label ?? key;
    if (field.description) {
        const desc = document.createElement("span");
        desc.className = "fulc-config-field-desc";
        desc.textContent = ` — ${field.description}`;
        label.appendChild(desc);
    }
    wrapper.appendChild(label);
    let input;
    if (field.type === "select" && field.options) {
        const sel = document.createElement("select");
        sel.id = `fulc-config-${key}`;
        sel.name = key;
        for (const opt of field.options) {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            if (currentValue === opt)
                o.selected = true;
            sel.appendChild(o);
        }
        input = sel;
    }
    else if (field.type === "boolean") {
        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.id = `fulc-config-${key}`;
        inp.name = key;
        inp.checked = Boolean(currentValue ?? field.default);
        input = inp;
    }
    else if (field.type === "number") {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.id = `fulc-config-${key}`;
        inp.name = key;
        inp.value = String(currentValue ?? field.default ?? "");
        if (field.min !== undefined)
            inp.min = String(field.min);
        if (field.max !== undefined)
            inp.max = String(field.max);
        input = inp;
    }
    else if (field.type === "color") {
        const inp = document.createElement("input");
        inp.type = "color";
        inp.id = `fulc-config-${key}`;
        inp.name = key;
        inp.value = String(currentValue ?? field.default ?? "#000000");
        input = inp;
    }
    else {
        // "string" and fallback
        const inp = document.createElement("input");
        inp.type = "text";
        inp.id = `fulc-config-${key}`;
        inp.name = key;
        inp.value = String(currentValue ?? field.default ?? "");
        input = inp;
    }
    wrapper.appendChild(input);
    return wrapper;
}
function readFieldValue(key, field, form) {
    const el = form.querySelector(`#fulc-config-${key}`);
    if (!el)
        return field.default ?? null;
    if (field.type === "boolean")
        return el.checked;
    if (field.type === "number") {
        const n = parseFloat(el.value);
        return Number.isNaN(n) ? (field.default ?? null) : n;
    }
    return el.value;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const config = {
    get(key) {
        const raw = readRaw(namespace() + key);
        if (raw === null)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    },
    set(key, value) {
        const ns = namespace();
        writeRaw(ns + key, JSON.stringify(value));
        events.emit(CONFIG_CHANGED_EVENT, { key, value });
        debugLog(`config.set("${key}")`);
        const appId = requireAppId("config.set");
        return pushServerConfig(appId, getAllFromStorage()).then(() => undefined);
    },
    getAll() {
        return getAllFromStorage();
    },
    async loadFromServer() {
        const appId = requireAppId("config.loadFromServer");
        const serverCfg = await fetchServerConfig(appId);
        if (!serverCfg)
            return;
        const ns = namespace();
        for (const [k, v] of Object.entries(serverCfg)) {
            writeRaw(ns + k, JSON.stringify(v));
        }
        debugLog(`config.loadFromServer: ${Object.keys(serverCfg).length} keys`);
    },
    onChange(callback) {
        return events.on(CONFIG_CHANGED_EVENT, ({ key, value }) => callback(key, value));
    },
    exportConfig() {
        return JSON.stringify(getAllFromStorage(), null, 2);
    },
    async importConfig(json) {
        const parsed = JSON.parse(json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("fulcrumaxe-os config.importConfig: expected a JSON object");
        }
        const obj = parsed;
        const ns = namespace();
        for (const [k, v] of Object.entries(obj)) {
            writeRaw(ns + k, JSON.stringify(v));
        }
        const appId = requireAppId("config.importConfig");
        await pushServerConfig(appId, obj);
        events.emit(CONFIG_CHANGED_EVENT, { key: "*", value: obj });
    },
    async renderSettingsPanel(container, schema) {
        // Try to fetch schema from the manifest when not supplied by the caller.
        let resolvedSchema = schema;
        if (!resolvedSchema) {
            try {
                const appId = requireAppId("config.renderSettingsPanel");
                const res = await fetch(`/api/apps/${encodeURIComponent(appId)}`, {
                    credentials: "same-origin",
                });
                if (res.ok) {
                    const body = await res.json();
                    resolvedSchema = body?.data?.manifest?.config_schema;
                }
            }
            catch {
                /* schema stays undefined */
            }
        }
        container.innerHTML = "";
        container.className = "fulc-config-panel";
        if (!resolvedSchema || Object.keys(resolvedSchema).length === 0) {
            const msg = document.createElement("p");
            msg.className = "fulc-config-empty";
            msg.textContent = "No configuration options available for this app.";
            container.appendChild(msg);
            return;
        }
        const currentCfg = config.getAll();
        const form = document.createElement("form");
        form.className = "fulc-config-form";
        form.addEventListener("submit", (e) => e.preventDefault());
        for (const [key, field] of Object.entries(resolvedSchema)) {
            form.appendChild(buildFieldInput(key, field, currentCfg[key] ?? field.default));
        }
        const actions = document.createElement("div");
        actions.className = "fulc-config-actions";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "Save";
        saveBtn.className = "fulc-config-save-btn";
        saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving…";
            try {
                for (const [key, field] of Object.entries(resolvedSchema)) {
                    await config.set(key, readFieldValue(key, field, form));
                }
                saveBtn.textContent = "Saved ✓";
                setTimeout(() => {
                    saveBtn.textContent = "Save";
                    saveBtn.disabled = false;
                }, 1500);
            }
            catch {
                saveBtn.textContent = "Error saving";
                saveBtn.disabled = false;
            }
        });
        const exportBtn = document.createElement("button");
        exportBtn.type = "button";
        exportBtn.textContent = "Export";
        exportBtn.className = "fulc-config-export-btn";
        exportBtn.addEventListener("click", () => {
            const json = config.exportConfig();
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const appId = requireAppId("config.export");
            a.download = `${appId}-config.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
        const importBtn = document.createElement("button");
        importBtn.type = "button";
        importBtn.textContent = "Import";
        importBtn.className = "fulc-config-import-btn";
        importBtn.addEventListener("click", () => {
            const picker = document.createElement("input");
            picker.type = "file";
            picker.accept = ".json,application/json";
            picker.addEventListener("change", async () => {
                const file = picker.files?.[0];
                if (!file)
                    return;
                try {
                    const text = await file.text();
                    await config.importConfig(text);
                    // Re-render so input values reflect the imported state.
                    await config.renderSettingsPanel(container, resolvedSchema);
                }
                catch (err) {
                    console.error("fulcrumaxe-os config.importConfig failed:", err);
                }
            });
            picker.click();
        });
        actions.appendChild(saveBtn);
        actions.appendChild(exportBtn);
        actions.appendChild(importBtn);
        form.appendChild(actions);
        container.appendChild(form);
    },
};
//# sourceMappingURL=config.js.map