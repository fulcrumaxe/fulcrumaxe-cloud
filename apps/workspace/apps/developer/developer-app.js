// D#37 WS-F7a / WS-F7b: the Developer app. Registers the window with the
// desktop and gives it three tabs: API tokens (developer-tokens.js), Webhooks
// (developer-webhooks.js) and API reference (developer-apiref.js). The last two
// are mounted the first time they are opened, so opening the app still makes
// only the token requests.
//
// Registration goes through the FULC global that the shell's SDK script
// (sdk/fulc-sdk.umd.js, loaded before every app) already provides, not through
// an ES import of sdk/fulc-sdk.js: that import pulls in eleven more module
// files, and the WS-D boot budget (at most 90 static requests) has no room
// for them.
import { h } from "../_lib/dom.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { mountTokens } from "./developer-tokens.js";
import { mountWebhooks } from "./developer-webhooks.js";
import { mountApiRef } from "./developer-apiref.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Developer app: the FULC SDK global is missing");
}

const TABS = [
  { id: "tokens", label: "API tokens", mount: mountTokens },
  { id: "webhooks", label: "Webhooks", mount: mountWebhooks },
  // WS-F15b: gets show(), so its "Manage in Webhooks" buttons keep the secret guard.
  { id: "apiref", label: "API reference", mount: mountApiRef },
];

let current = null;

// Live updates (D#37 WS-LV2). At most one re-fetch per LIVE_WINDOW_MS: the
// first event fetches at once, any that arrive inside the window collapse into
// one more fetch when it ends, so 5 events in 1 s make at most 2 fetches.
const LIVE_WINDOW_MS = 1000;
function coalesced(fn) {
  let waiting = false;
  let pending = false;
  const fire = () => {
    waiting = true;
    fn();
    setTimeout(() => {
      waiting = false;
      if (pending) {
        pending = false;
        fire();
      }
    }, LIVE_WINDOW_MS);
  };
  return () => (waiting ? void (pending = true) : fire());
}

function teardown() {
  if (current) {
    current.destroy();
    current = null;
  }
}

function mountApp(contentEl) {
  const handles = {}; // tab id -> { destroy, revealOpen }
  const panels = {};
  const tabButtons = {};
  let active = "tokens";

  const notice = h("p", { class: "dev-tab-note", role: "status", "aria-live": "polite", "data-testid": "dev-tab-note" });

  function show(id) {
    const leaving = handles[active];
    if (id !== active && leaving && leaving.revealOpen()) {
      // A one-time secret is on screen: leaving now would hide it before it
      // is copied. The user closes it with Done first.
      notice.textContent = "Finish with the secret on screen first: copy it, then press Done.";
      return;
    }
    notice.textContent = "";
    active = id;
    for (const tab of TABS) {
      const on = tab.id === id;
      panels[tab.id].hidden = !on;
      tabButtons[tab.id].setAttribute("aria-selected", on ? "true" : "false");
      tabButtons[tab.id].tabIndex = on ? 0 : -1;
      if (on && !handles[tab.id]) handles[tab.id] = tab.mount(panels[tab.id], show);
    }
  }

  const bar = h("div", { class: "dev-tabs", role: "tablist", "aria-label": "Developer", "data-testid": "dev-tabs" });
  TABS.forEach((tab, i) => {
    const btn = h(
      "button",
      {
        type: "button",
        role: "tab",
        id: "dev-tab-" + tab.id,
        class: "dev-tab",
        "aria-controls": "dev-panel-" + tab.id,
        "data-testid": "dev-tab-" + tab.id,
        onClick: () => show(tab.id),
      },
      tab.label
    );
    // Arrow keys move between tabs (the ARIA tabs pattern).
    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const next = TABS[(i + (ev.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      ev.preventDefault();
      show(next.id);
      if (active === next.id) tabButtons[next.id].focus();
    });
    tabButtons[tab.id] = btn;
    bar.appendChild(btn);
    panels[tab.id] = h("div", {
      class: "dev-tabpanel",
      role: "tabpanel",
      id: "dev-panel-" + tab.id,
      "aria-labelledby": "dev-tab-" + tab.id,
      hidden: true,
    });
  });

  const shell = h("div", { class: "dev-shell" }, bar, notice, TABS.map((t) => panels[t.id]));
  contentEl.replaceChildren(shell);
  show("tokens");

  // Subscribed while the window is open, dropped when it closes. The webhooks
  // tab exists only once it has been opened; before that there is nothing to
  // refresh, and its first mount fetches anyway.
  const refreshTokens = coalesced(() => handles.tokens && handles.tokens.refresh());
  const refreshWebhooks = coalesced(() => handles.webhooks && handles.webhooks.refresh());
  const unsubscribe = [
    on("api_token.created", refreshTokens),
    on("api_token.revoked", refreshTokens),
    on("webhook_endpoint.disabled", refreshWebhooks),
    onRefresh(() => {
      refreshTokens();
      refreshWebhooks();
    }),
  ];

  return {
    destroy() {
      for (const off of unsubscribe) off();
      for (const id of Object.keys(handles)) handles[id].destroy();
      contentEl.replaceChildren();
    },
  };
}

FULC.register({
  id: "developer",
  title: "Developer",
  icon: "</>",
  defaultSize: { w: 820, h: 580 },
  onOpen({ contentEl }) {
    teardown();
    current = mountApp(contentEl);
  },
  // Closing the window drops any reveal panel's secret along with its DOM.
  onClose() {
    teardown();
  },
});
