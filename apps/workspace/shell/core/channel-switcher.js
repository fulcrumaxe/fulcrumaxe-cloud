// ── Shared channel switcher widget (epic-34 task 15) ────────────────────
// Renders a radio-style channel selector with a confirmation modal that
// fires whenever the user picks a channel less stable than their current
// one. Canary additionally requires an explicit "I understand" checkbox.
//
// Used by:
//   • desktop Updates app (apps/updates/updates-app.js)
//   • App Store (src-ts/apps/app-store/app-store-channel-toggle.tsx)
//   • Cloud Manage deployment detail (src-ts/apps/cloud-manage/cm-channel-selector.ts)
//
// All three surfaces use the same channel set, the same stability ranks,
// and the same modal copy so the UX feels uniform regardless of where the
// user changes their channel.

const CHANNELS = [
    {
        id: "stable",
        label: "Stable",
        desc: "Most users · ~monthly cadence · production-ready",
        stability: 0,
    },
    {
        id: "lts",
        label: "LTS",
        desc: "Security patches only · multi-month freezes",
        stability: 0,
    },
    {
        id: "beta",
        label: "Beta",
        desc: "Opt-in · ~weekly · feature preview, may have rough edges",
        stability: 1,
    },
    {
        id: "canary",
        label: "Canary",
        desc: "After every commit · MAY BREAK · for testers",
        stability: 2,
    },
];

// The docs site isn't deployed yet — point at the
// in-repo release engineering doc on GitHub until it is. Flip back to
// the docs host once it ships.
const DOCS_URL = "https://github.com/fulcrumaxe/fulcrumaxe-os/blob/main/docs/release-engineering.md";

function findChannel(id) {
    return CHANNELS.find((c) => c.id === id) || CHANNELS[0];
}

function severityCopy(toChannel, surface, context) {
    const where = context ? ` for "${context}"` : "";
    if (toChannel.id === "canary") {
        return {
            title: "Switch to Canary?",
            body:
                `Canary releases ship after every commit and MAY BREAK${where}. ` +
                `Use this only if you are willing to file bugs and recover from a broken build. ` +
                `You can switch back to Stable at any time.`,
            requireAck: true,
            ackLabel: "I understand canary may break.",
            confirmLabel: "Switch to canary",
            tier: "critical",
        };
    }
    if (toChannel.id === "beta") {
        return {
            title: "Switch to Beta?",
            body:
                `Beta releases preview new features${where} but may include bugs that ` +
                `slipped past the stable cut. Updates arrive about once a week.`,
            requireAck: false,
            confirmLabel: "Switch to beta",
            tier: "warn",
        };
    }
    if (toChannel.id === "lts") {
        return {
            title: "Switch to LTS?",
            body:
                `LTS receives security patches only${where} — no new features and ` +
                `infrequent updates. Use this for environments that prefer stability ` +
                `over freshness.`,
            requireAck: false,
            confirmLabel: "Switch to LTS",
            tier: "info",
        };
    }
    return {
        title: "Switch to Stable?",
        body: `Stable is the default channel${where}. You'll receive updates about once a month.`,
        requireAck: false,
        confirmLabel: "Switch to stable",
        tier: "info",
    };
}

// Returns true if `to` is *less stable* than `from` (numerically higher rank
// or a cross-track move into beta/canary from lts/stable).
function isDowngradeToLessStable(fromId, toId) {
    const from = findChannel(fromId);
    const to = findChannel(toId);
    return to.stability > from.stability;
}

function buildModal(copy) {
    const overlay = document.createElement("div");
    overlay.className = "fulc-channel-modal-overlay";

    const card = document.createElement("div");
    card.className = `fulc-channel-modal fulc-channel-modal-${copy.tier}`;
    // Both action buttons were already native and Escape already closed the
    // modal — what was missing is that it is announced as a dialog and that
    // focus ever enters it. Without the focus move below a keyboard user has to
    // tab the whole page to reach a modal that is covering it.
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    overlay.appendChild(card);

    const h = document.createElement("h3");
    h.textContent = copy.title;
    h.id = `fulc-channel-modal-title-${Math.random().toString(36).slice(2, 8)}`;
    card.setAttribute("aria-labelledby", h.id);
    card.appendChild(h);

    const p = document.createElement("p");
    p.textContent = copy.body;
    card.appendChild(p);

    const docs = document.createElement("a");
    docs.href = DOCS_URL;
    docs.target = "_blank";
    docs.rel = "noopener";
    docs.className = "fulc-channel-modal-docs";
    docs.textContent = "What does each channel mean? →";
    card.appendChild(docs);

    let ackInput = null;
    if (copy.requireAck) {
        const ack = document.createElement("label");
        ack.className = "fulc-channel-modal-ack";
        ackInput = document.createElement("input");
        ackInput.type = "checkbox";
        const ackText = document.createElement("span");
        ackText.textContent = copy.ackLabel || "I understand.";
        ack.appendChild(ackInput);
        ack.appendChild(ackText);
        card.appendChild(ack);
    }

    const actions = document.createElement("div");
    actions.className = "fulc-channel-modal-actions";

    const cancel = document.createElement("button");
    cancel.className = "fulc-channel-modal-cancel";
    cancel.type = "button";
    cancel.textContent = "Cancel";

    const confirm = document.createElement("button");
    confirm.className = "fulc-channel-modal-confirm";
    confirm.type = "button";
    confirm.textContent = copy.confirmLabel;
    if (copy.requireAck) confirm.disabled = true;

    if (ackInput) {
        ackInput.addEventListener("change", () => {
            confirm.disabled = !ackInput.checked;
        });
    }

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    card.appendChild(actions);

    return { overlay, cancel, confirm };
}

function confirmSwitch(fromChannel, toChannel, surface, context) {
    return new Promise((resolve) => {
        const to = findChannel(toChannel);
        if (!isDowngradeToLessStable(fromChannel, toChannel)) {
            // Same-or-more-stable destination — no friction.
            resolve(true);
            return;
        }
        const copy = severityCopy(to, surface, context);
        const { overlay, cancel, confirm } = buildModal(copy);

        function close(result) {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            document.removeEventListener("keydown", onKey, true);
            resolve(result);
        }
        function onKey(ev) {
            if (ev.key === "Escape") close(false);
        }

        cancel.addEventListener("click", () => close(false));
        confirm.addEventListener("click", () => close(true));
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(overlay);
        // Cancel, not confirm: this modal only appears for a downgrade to a
        // less stable channel, so the safe option is the one that gets focus.
        cancel.focus({ preventScroll: true });
    });
}

// Render a radio-style channel selector into `host`. Calls `opts.onChange`
// with the channel id only after the user has confirmed (when needed).
function render(host, opts) {
    const surface = opts.surface || "desktop";
    const channels = opts.channels || CHANNELS;
    const current = opts.current || "stable";
    const disabled = !!opts.disabled;
    const context = opts.context || null;
    const groupName = opts.groupName ||
        `fulc-channel-${surface}-${Math.random().toString(36).slice(2, 8)}`;

    host.replaceChildren();
    host.classList.add("fulc-channel-switcher");

    for (const c of channels) {
        const row = document.createElement("label");
        row.className = "fulc-channel-row";
        if (c.id === current) row.classList.add("fulc-channel-row-active");

        const input = document.createElement("input");
        input.type = "radio";
        input.name = groupName;
        input.value = c.id;
        input.checked = c.id === current;
        input.disabled = disabled;

        input.addEventListener("change", async () => {
            if (input.value === current) return;
            input.disabled = true;
            const ok = await confirmSwitch(current, c.id, surface, context);
            input.disabled = disabled;
            if (!ok) {
                // Restore selection
                const restored = host.querySelector(
                    `input[type=radio][value="${current}"]`,
                );
                if (restored) restored.checked = true;
                return;
            }
            try {
                await opts.onChange(c.id);
            } catch (err) {
                console.warn("[channel-switcher] onChange failed:", err);
                const restored = host.querySelector(
                    `input[type=radio][value="${current}"]`,
                );
                if (restored) restored.checked = true;
            }
        });

        const text = document.createElement("span");
        text.className = "fulc-channel-text";
        const labelEl = document.createElement("strong");
        labelEl.textContent = c.label;
        const descEl = document.createElement("span");
        descEl.className = "fulc-channel-desc";
        descEl.textContent = c.desc;
        text.appendChild(labelEl);
        text.appendChild(document.createTextNode(" — "));
        text.appendChild(descEl);

        row.appendChild(input);
        row.appendChild(text);
        host.appendChild(row);
    }

    const footer = document.createElement("div");
    footer.className = "fulc-channel-footer";
    const a = document.createElement("a");
    a.href = DOCS_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Channel docs ↗";
    footer.appendChild(a);
    host.appendChild(footer);
}

const api = {
    CHANNELS,
    DOCS_URL,
    findChannel,
    isDowngradeToLessStable,
    confirmSwitch,
    render,
};

if (typeof window !== "undefined") {
    window.FULCChannelSwitcher = api;
}

export default api;
