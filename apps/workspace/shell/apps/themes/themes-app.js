// ── Themes App ────────────────────────────────────────────────────────
// Visual gallery and live switcher for fulcrumaxe-os theme experiences.
// Ctrl+Alt+T — open Themes app.
import { FULCApps } from "../../core/app-registry.js";
import { FULCTheme } from "../../core/theme-manager.js";
import { FULCLayout } from "../../core/theme-layout.js";
import "./themes-preview.js";
function buildInstance(contentEl) {
    const inst = {
        el: contentEl,
        _render() { themesRender(this); },
        _renderGallery() { themesRenderGallery(this); },
        _renderQuick() { themesRenderQuick(this); },
        _bindChangeEvents() { themesBindChangeEvents(this); },
        _applyLayoutOverride(partial) {
            if (!FULCLayout)
                return;
            const current = FULCLayout.current() || {};
            const merged = Object.assign({}, current, partial);
            FULCLayout.apply(merged);
        },
        _applyToolbarPlacement(placement) {
            // Store on body for CSS and future windows — do NOT mutate existing app DOM,
            // which breaks apps that don't declare [data-zone="toolbar"].
            document.body.dataset.toolbarPlacement = placement;
            document.dispatchEvent(new CustomEvent("fulc-toolbar-placement-change", { detail: { placement: placement } }));
        },
    };
    inst._render();
    inst._bindChangeEvents();
    return inst;
}
function themesRender(self) {
    const experiencesTab = document.createElement("button");
    experiencesTab.className = "themes-tab active";
    experiencesTab.dataset.panel = "experiences";
    experiencesTab.textContent = "EXPERIENCES";

    const quickTab = document.createElement("button");
    quickTab.className = "themes-tab";
    quickTab.dataset.panel = "quick";
    quickTab.textContent = "QUICK SETTINGS";

    const tabsDiv = document.createElement("div");
    tabsDiv.className = "themes-tabs";
    tabsDiv.append(experiencesTab, quickTab);

    const galleryInner = document.createElement("div");
    galleryInner.className = "themes-gallery";
    galleryInner.id = "themes-gallery";
    const experiencesPanel = document.createElement("div");
    experiencesPanel.className = "themes-panel active";
    experiencesPanel.dataset.panel = "experiences";
    experiencesPanel.append(galleryInner);

    const quickInner = document.createElement("div");
    quickInner.className = "themes-quick";
    quickInner.id = "themes-quick";
    const quickPanel = document.createElement("div");
    quickPanel.className = "themes-panel";
    quickPanel.dataset.panel = "quick";
    quickPanel.append(quickInner);

    const themesAppDiv = document.createElement("div");
    themesAppDiv.className = "themes-app";
    themesAppDiv.append(tabsDiv, experiencesPanel, quickPanel);

    self.el.replaceChildren(themesAppDiv);
    self.el.querySelectorAll(".themes-tab").forEach(function (tab) {
        tab.addEventListener("click", function () {
            self.el.querySelectorAll(".themes-tab").forEach(function (t) { t.classList.remove("active"); });
            self.el.querySelectorAll(".themes-panel").forEach(function (p) { p.classList.remove("active"); });
            tab.classList.add("active");
            const panelName = tab.dataset.panel;
            if (!panelName)
                return;
            const panel = self.el.querySelector('.themes-panel[data-panel="' + panelName + '"]');
            if (panel)
                panel.classList.add("active");
        });
    });
    themesRenderGallery(self);
    themesRenderQuick(self);
}
function themesRenderGallery(self) {
    const gallery = self.el.querySelector("#themes-gallery");
    if (!gallery)
        return;
    gallery.replaceChildren();
    if (!FULCTheme)
        return;
    const experiences = FULCTheme.list();
    const current = FULCTheme.current();
    const currentId = current ? current.id : null;
    experiences.forEach(function (exp) {
        const card = window.ThemesPreview.createCard(exp, exp.id === currentId);
        const btn = card.querySelector(".theme-card-apply");
        if (btn && exp.id !== currentId) {
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                FULCTheme.apply(exp.id);
            });
        }
        card.addEventListener("click", function () {
            const cur = FULCTheme.current();
            const curId = cur ? cur.id : null;
            if (exp.id !== curId) {
                FULCTheme.apply(exp.id);
            }
        });
        gallery.appendChild(card);
    });
}
function themesRenderQuick(self) {
    const quick = self.el.querySelector("#themes-quick");
    if (!quick)
        return;
    const layout = (FULCLayout ? FULCLayout.current() : null) || {};
    const body = document.body;
    const tbPos = layout["taskbar-position"] || body.dataset.taskbarPosition || "bottom";
    const tbStyle = layout["taskbar-style"] || body.dataset.taskbarStyle || "bar";
    const chrome = layout["window-chrome"] || body.dataset.windowChrome || "classic";
    const toolbar = body.dataset.toolbarPlacement || "top";
    const density = body.dataset.density || "comfortable";
    function quickRow(labelText, selectId, options, selectedValue) {
        const label = document.createElement("label");
        label.textContent = labelText;
        const select = document.createElement("select");
        select.className = "themes-quick-select";
        select.id = selectId;
        options.forEach(function (o) {
            select.append(opt(o[0], o[1], selectedValue));
        });
        const row = document.createElement("div");
        row.className = "themes-quick-row";
        row.append(label, select);
        return row;
    }
    function quickSection(labelText, rows) {
        const label = document.createElement("div");
        label.className = "themes-quick-label";
        label.textContent = labelText;
        const section = document.createElement("div");
        section.className = "themes-quick-section";
        // dom-insert-ok: both callers pass a literal list of row elements built in this file
        section.append(label, ...rows);
        return section;
    }
    const layoutSection = quickSection("Layout Overrides", [
        quickRow("Taskbar Position", "tq-taskbar-pos", [
            ["bottom", "Bottom Bar"], ["top", "Top Bar"], ["left", "Left Rail"], ["right", "Right Rail"]
        ], tbPos),
        quickRow("Taskbar Style", "tq-taskbar-style", [
            ["bar", "Full Bar"], ["dock", "Dock"], ["slim-icons", "Slim Icons"], ["hidden", "Auto-hide"]
        ], tbStyle),
        quickRow("Window Chrome", "tq-chrome", [
            ["classic", "Classic"], ["minimal", "Minimal"], ["rounded", "Rounded"], ["sharp", "Sharp"], ["neon-border", "Neon Border"]
        ], chrome)
    ]);
    const dataSection = quickSection("Data Overrides", [
        quickRow("UI Density", "tq-density", [
            ["compact", "Compact"], ["comfortable", "Comfortable"], ["broadcast", "Broadcast"]
        ], density),
        quickRow("Toolbar Side", "tq-toolbar", [
            ["top", "Top"], ["left", "Left"], ["floating", "Floating"], ["collapsed", "Collapsed"]
        ], toolbar)
    ]);
    quick.replaceChildren(layoutSection, dataSection);
    const tbPosSel = quick.querySelector("#tq-taskbar-pos");
    const tbStyleSel = quick.querySelector("#tq-taskbar-style");
    const chromeSel = quick.querySelector("#tq-chrome");
    const densitySel = quick.querySelector("#tq-density");
    const toolbarSel = quick.querySelector("#tq-toolbar");
    if (tbPosSel) {
        tbPosSel.addEventListener("change", function (e) {
            self._applyLayoutOverride({ "taskbar-position": e.target.value });
        });
    }
    if (tbStyleSel) {
        tbStyleSel.addEventListener("change", function (e) {
            self._applyLayoutOverride({ "taskbar-style": e.target.value });
        });
    }
    if (chromeSel) {
        chromeSel.addEventListener("change", function (e) {
            self._applyLayoutOverride({ "window-chrome": e.target.value });
        });
    }
    if (densitySel) {
        densitySel.addEventListener("change", function (e) {
            const themeInternal = FULCTheme;
            if (themeInternal._applyData) {
                themeInternal._applyData({ density: e.target.value });
            }
        });
    }
    if (toolbarSel) {
        toolbarSel.addEventListener("change", function (e) {
            self._applyToolbarPlacement(e.target.value);
        });
    }
}
function themesBindChangeEvents(self) {
    // Re-render gallery when theme changes, re-render quick when theme OR layout changes
    document.addEventListener("fulc-theme-change", function () {
        themesRenderGallery(self);
        themesRenderQuick(self);
    });
    document.addEventListener("fulc-layout-change", function () {
        themesRenderQuick(self);
    });
}
// ── Helper ─────────────────────────────────────────────────────────
/** Build a single `<option>` element; exported for unit tests. */
export function opt(value, label, selected) {
    const optionEl = document.createElement("option");
    optionEl.value = value;
    optionEl.textContent = label;
    if (selected === value) optionEl.selected = true;
    return optionEl;
}
// ── Registration ───────────────────────────────────────────────────
const themesApp = {
    title: "THEMES",
    icon: "◈",
    adminOnly: false,
    defaultSize: { w: 560, h: 460 },
    minSize: { w: 420, h: 320 },
    _instance: null,
    onOpen(contentEl) {
        this._instance = buildInstance(contentEl);
    },
    onClose() {
        this._instance = null;
    },
    onFocus() { },
};
FULCApps.register("themes", themesApp);
//# sourceMappingURL=themes-app.js.map