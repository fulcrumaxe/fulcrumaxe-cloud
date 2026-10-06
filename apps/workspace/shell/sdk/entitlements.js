// Entitlement gating for marketplace apps.
//
// epic-28 task 05 will eventually attach a `FULCEntitlements` global that
// wraps the user's resolved capability set. Until then, the SDK's `can()`
// returns `true` unless an explicit deny override is set on
// `window.__FULC_DENY_CAPS__` — this matches the dev resolver's
// allow-everything behaviour while letting tests simulate denied gates.
//
// `gate(element, cap)` overlays a lock icon, intercepts clicks, and (if the
// user lacks the cap) opens an upgrade modal. If `FULCModals` exposes an
// `upgradePrompt` helper later (epic-28 task 09), we delegate to it; for now
// we render a minimal modal in pure DOM so the gate UX works standalone.
import { debugLog } from "./internal.js";
function fulcEntitlements() {
    if (typeof window === "undefined")
        return null;
    return window.FULCEntitlements ?? null;
}
function fulcModals() {
    if (typeof window === "undefined")
        return null;
    return window.FULCModals ?? null;
}
function decide(capability) {
    if (typeof window !== "undefined") {
        const denied = window.__FULC_DENY_CAPS__;
        if (Array.isArray(denied) && denied.includes(capability)) {
            return { capability, allowed: false, reason: "Denied by tenant policy" };
        }
        const granted = window.__FULC_GRANT_CAPS__;
        if (Array.isArray(granted) && granted.includes(capability)) {
            return { capability, allowed: true };
        }
    }
    const ent = fulcEntitlements();
    if (ent?.check) {
        try {
            return ent.check(capability);
        }
        catch (err) {
            console.warn(`fulcrumaxe-os entitlements.check("${capability}") threw, allowing:`, err);
        }
    }
    if (ent?.can) {
        try {
            return { capability, allowed: !!ent.can(capability) };
        }
        catch (err) {
            console.warn(`fulcrumaxe-os entitlements.can("${capability}") threw, allowing:`, err);
        }
    }
    // Default-open in dev — matches the server's wildcard resolver.
    return { capability, allowed: true, reason: "default-open (no FULCEntitlements global)" };
}
const GATE_FLAG = "__fulcGated";
const GATE_LOCK_CLASS = "fulc-sdk-gate-lock";
const GATE_LOCKED_CLASS = "fulc-sdk-gate-locked";
const gates = new WeakMap();
function ensureLockStyle() {
    if (typeof document === "undefined")
        return;
    if (document.getElementById("fulc-sdk-gate-style"))
        return;
    const style = document.createElement("style");
    style.id = "fulc-sdk-gate-style";
    style.textContent = `
.${GATE_LOCK_CLASS} {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 14px;
  height: 14px;
  pointer-events: none;
  font-size: 12px;
  line-height: 14px;
  text-align: center;
  color: var(--accent, #0c0);
  opacity: 0.85;
}
.${GATE_LOCKED_CLASS} { cursor: not-allowed !important; opacity: 0.65; }
.fulc-sdk-gate-modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  z-index: 99999; display: flex; align-items: center; justify-content: center;
}
.fulc-sdk-gate-modal {
  background: var(--bg, #111); color: var(--fg, #ddd);
  border: 1px solid var(--accent, #0c0);
  padding: 24px 28px; min-width: 320px; max-width: 480px;
  font-family: var(--font-mono, monospace);
}
.fulc-sdk-gate-modal h2 { margin: 0 0 12px; font-size: 16px; color: var(--accent, #0c0); }
.fulc-sdk-gate-modal p { margin: 0 0 20px; font-size: 13px; line-height: 1.5; }
.fulc-sdk-gate-modal .fulc-sdk-gate-actions { display: flex; gap: 12px; justify-content: flex-end; }
.fulc-sdk-gate-modal button {
  background: transparent; color: inherit; border: 1px solid var(--accent, #0c0);
  padding: 6px 14px; cursor: pointer; font-family: inherit; font-size: 12px;
}
.fulc-sdk-gate-modal button.fulc-sdk-gate-cta {
  background: var(--accent, #0c0); color: var(--bg, #111);
}
`;
    document.head.appendChild(style);
}
function showUpgradeModal(capability, opts) {
    // Prefer host integration when available — keeps gate UX consistent with
    // future epic-28 work without coupling to it.
    const modals = fulcModals();
    if (modals?.upgradePrompt) {
        try {
            modals.upgradePrompt({
                capability,
                message: opts.upgradeMessage,
                ctaLabel: opts.ctaLabel,
            });
            return;
        }
        catch (err) {
            console.warn("FULCModals.upgradePrompt failed, falling back:", err);
        }
    }
    if (typeof document === "undefined")
        return;
    ensureLockStyle();
    const backdrop = document.createElement("div");
    backdrop.className = "fulc-sdk-gate-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "fulc-sdk-gate-modal";
    const heading = document.createElement("h2");
    heading.textContent = "Upgrade required";
    const body = document.createElement("p");
    body.textContent =
        opts.upgradeMessage ??
            `This feature requires the "${capability}" capability. Upgrade your plan or contact your tenant admin to enable it.`;
    const actions = document.createElement("div");
    actions.className = "fulc-sdk-gate-actions";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "fulc-sdk-gate-cta";
    cta.textContent = opts.ctaLabel ?? "Upgrade";
    modal.append(heading, body, actions);
    actions.append(dismiss, cta);
    backdrop.append(modal);
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    dismiss.addEventListener("click", close);
    cta.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop)
            close();
    });
}
export const entitlements = {
    can(capability) {
        return decide(capability).allowed;
    },
    check(capability) {
        return decide(capability);
    },
    gate(element, capability, options = {}) {
        if (!element)
            return;
        if (typeof document === "undefined")
            return;
        ensureLockStyle();
        const previous = gates.get(element);
        if (previous) {
            // Re-applying a gate: tear down the old wrapper before re-wiring so the
            // capability/options can change.
            this.ungate(element);
        }
        const decision = decide(capability);
        const allowed = decision.allowed;
        const computedPos = window.getComputedStyle(element).position;
        const prevPosition = element.style.position;
        if (computedPos === "static") {
            element.style.position = "relative";
        }
        let lockEl;
        if (!allowed && !options.noLockIcon) {
            lockEl = document.createElement("span");
            lockEl.className = GATE_LOCK_CLASS;
            lockEl.textContent = "🔒";
            lockEl.setAttribute("aria-hidden", "true");
            element.appendChild(lockEl);
            element.classList.add(GATE_LOCKED_CLASS);
        }
        const prevTitle = element.title;
        if (!allowed) {
            element.title = decision.reason
                ? `Locked: ${decision.reason}`
                : `Locked — requires "${capability}"`;
            element.setAttribute("aria-disabled", "true");
        }
        const clickHandler = (e) => {
            const fresh = decide(capability);
            if (fresh.allowed)
                return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const modals = fulcModals();
            modals?.toast?.(`Locked: ${capability}`, 1800);
            showUpgradeModal(capability, options);
        };
        element.addEventListener("click", clickHandler, { capture: true });
        const state = {
            capability,
            options,
            clickHandler,
            lockEl,
            prevTitle,
            prevPosition,
        };
        gates.set(element, state);
        element[GATE_FLAG] = true;
        debugLog(`gate("${capability}") on element <${element.tagName.toLowerCase()}>: allowed=${allowed}`);
    },
    ungate(element) {
        const state = gates.get(element);
        if (!state)
            return;
        element.removeEventListener("click", state.clickHandler, { capture: true });
        state.lockEl?.remove();
        element.classList.remove(GATE_LOCKED_CLASS);
        element.removeAttribute("aria-disabled");
        if (state.prevTitle === undefined || state.prevTitle === "") {
            element.removeAttribute("title");
        }
        else {
            element.title = state.prevTitle;
        }
        if (state.prevPosition !== undefined) {
            element.style.position = state.prevPosition;
        }
        gates.delete(element);
        delete element[GATE_FLAG];
    },
};
//# sourceMappingURL=entitlements.js.map