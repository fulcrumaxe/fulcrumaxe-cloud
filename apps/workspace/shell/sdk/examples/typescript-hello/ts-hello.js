// Sample TypeScript marketplace app exercising the @fulc/sdk surface.
//
// Demonstrates:
//   • register() with onOpen rendering hook
//   • state.set/get for persisting a click counter
//   • theme.onChange to react to theme switches
//   • entitlements.gate to show the standard upgrade UX on a Pro button
//   • events.broadcast to notify other contexts of the same app
import { register, state, theme, events, entitlements, } from "../../fulc-sdk.js";
const APP_ID = "com.fulc.examples.ts-hello";
function loadSnapshot() {
    return state.get("snapshot") ?? { clicks: 0, lastClickAt: 0 };
}
register({
    id: APP_ID,
    title: "TS Hello",
    icon: "TH",
    defaultSize: { w: 360, h: 240 },
    minSize: { w: 280, h: 200 },
    onOpen({ contentEl }) {
        const snap = loadSnapshot();
        contentEl.innerHTML = "";
        contentEl.style.padding = "16px";
        contentEl.style.fontFamily = "var(--font-mono, monospace)";
        const heading = document.createElement("h2");
        heading.textContent = "TS Hello — @fulc/sdk demo";
        heading.style.fontSize = "14px";
        heading.style.margin = "0 0 12px";
        const counter = document.createElement("p");
        counter.textContent = `Clicks: ${snap.clicks}`;
        const themeRow = document.createElement("p");
        themeRow.textContent = `Theme: ${theme.current().experience?.id ?? "(default)"}`;
        theme.onChange((t) => {
            themeRow.textContent = `Theme: ${t.experience?.id ?? "(default)"}`;
        });
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Click me";
        button.style.padding = "6px 12px";
        button.addEventListener("click", () => {
            const now = Date.now();
            const next = { clicks: snap.clicks + 1, lastClickAt: now };
            state.set("snapshot", next);
            snap.clicks = next.clicks;
            counter.textContent = `Clicks: ${snap.clicks}`;
            events.broadcast("ts-hello:clicked", { at: now, total: snap.clicks });
        });
        const proButton = document.createElement("button");
        proButton.type = "button";
        proButton.textContent = "Export PDF (Pro)";
        proButton.style.padding = "6px 12px";
        proButton.style.marginLeft = "8px";
        entitlements.gate(proButton, "com.fulc.examples.ts-hello.pro");
        contentEl.append(heading, counter, themeRow, button, proButton);
    },
});
//# sourceMappingURL=ts-hello.js.map