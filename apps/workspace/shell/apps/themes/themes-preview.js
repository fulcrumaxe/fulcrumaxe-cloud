// ── Themes Preview ────────────────────────────────────────────────────
// Renders a miniature CSS-based preview card for each theme experience.
// Exposes: window.ThemesPreview
function createCard(experience, isActive) {
    const card = document.createElement("div");
    card.className = "theme-card" + (isActive ? " theme-card--active" : "");
    card.dataset.experienceId = experience.id;
    const tokens = experience.tokens || {};
    const layout = experience.layout || {};
    const tbPos = layout["taskbar-position"] || "bottom";
    const tbStyle = layout["taskbar-style"] || "bar";
    const chrome = layout["window-chrome"] || "classic";

    const previewMini = document.createElement("div");
    previewMini.className = "theme-preview-mini";
    previewMini.dataset.tbPos = tbPos;
    previewMini.dataset.chrome = chrome;
    Object.entries(tokens).forEach(function (kv) {
        previewMini.style.setProperty("--" + kv[0], kv[1]);
    });

    const previewTaskbar = document.createElement("div");
    previewTaskbar.className = "tpm-taskbar tpm-pos--" + tbPos + " tpm-style--" + tbStyle;

    const previewWindow = document.createElement("div");
    previewWindow.className = "tpm-window tpm-chrome--" + chrome;
    const previewTitlebar = document.createElement("div");
    previewTitlebar.className = "tpm-titlebar";
    const previewContent = document.createElement("div");
    previewContent.className = "tpm-content";
    previewWindow.append(previewTitlebar, previewContent);

    previewMini.append(previewTaskbar, previewWindow);

    const cardName = document.createElement("div");
    cardName.className = "theme-card-name";
    cardName.textContent = experience.name || experience.id;

    const applyBtn = document.createElement("button");
    applyBtn.className = "theme-card-apply";
    applyBtn.dataset.id = experience.id;
    applyBtn.textContent = isActive ? "★ Active" : "Apply";

    card.replaceChildren(previewMini, cardName, applyBtn);
    return card;
}
export const ThemesPreview = {
    createCard: createCard,
};
window.ThemesPreview = ThemesPreview;
//# sourceMappingURL=themes-preview.js.map