// apps/workspace/test/theme-list-order.test.mjs
//
// FULCTheme.list() feeds the Themes gallery. Themes load lazily (only the one in use at boot, the rest in loadAll()), and fetches finish in
// any order, so list() must not hand back insertion order: it returns the shipped THEME_IDS order first, then anything else registered.
// The real core/theme-manager.js is loaded with a fake fetch whose answers are released in a chosen order, and a stored non-default theme.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "shell", "core");
const SHIPPED = ["classic-crt", "cyberpunk", "modern-flat", "nord", "retro-amber", "corporate", "orchard", "crystal"];
let stored = {};

vi.mock("../shell/core/theme-effects.js", () => ({ FULCEffects: { apply() {} } }));
vi.mock("../shell/core/theme-layout.js", () => ({ FULCLayout: { apply() {} } }));
vi.mock("../shell/core/storage-ns.js", () => ({ getNamespace: () => null, getItem: () => null, setItem: () => true }));
vi.mock("../shell/core/preferences-store.js", () => ({ readStoredPreferences: () => stored, storePreference: () => true }));

/** A fetch whose theme answers wait in `pending` until the test releases them, in any order. */
function installBrowser() {
  const pending = {};
  vi.stubGlobal("document", {
    documentElement: { style: { setProperty() {} } },
    body: { dataset: {} },
    dispatchEvent() {},
    addEventListener() {},
    fonts: { add() {} },
  });
  vi.stubGlobal("window", {});
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("CustomEvent", class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } });
  vi.stubGlobal("FontFace", class { load() { return Promise.resolve(this); } });
  vi.stubGlobal("fetch", (url) => {
    const id = String(url).replace(/^core\/themes\//, "").replace(/\.json$/, "");
    return new Promise((resolve) => {
      pending[id] = () => resolve({ ok: true, json: async () => JSON.parse(readFileSync(join(CORE, "themes", id + ".json"), "utf8")), text: async () => "" });
    });
  });
  return pending;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function boot(storedExperience) {
  vi.resetModules();
  stored = storedExperience ? { experience: storedExperience } : {};
  const pending = installBrowser();
  const { FULCTheme } = await import("../shell/core/theme-manager.js");
  await tick();
  return { FULCTheme, pending };
}

describe("FULCTheme.list() order", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("a stored non-default theme, other themes finishing out of order: list() is still THEME_IDS order", async () => {
    const { FULCTheme, pending } = await boot("nord");
    pending.nord(); // the one theme boot asks for
    await tick();
    expect(FULCTheme.current().id).toBe("nord");

    const all = FULCTheme.loadAll();
    await tick();
    // The rest finish in reverse, with the active one already in place.
    for (const id of [...SHIPPED].reverse()) if (id !== "nord") { pending[id](); await tick(); }
    const loaded = await all;

    expect(loaded.map((e) => e.id)).toEqual(SHIPPED);
    expect(FULCTheme.list().map((e) => e.id)).toEqual(SHIPPED);
  });

  it("a partly loaded list keeps THEME_IDS order too (active theme not first)", async () => {
    const { FULCTheme, pending } = await boot("crystal");
    pending.crystal();
    await tick();
    FULCTheme.loadAll();
    await tick();
    pending.orchard(); await tick();
    pending["classic-crt"](); await tick();
    expect(FULCTheme.list().map((e) => e.id)).toEqual(["classic-crt", "orchard", "crystal"]);
  });

  it("anything else registered comes after the shipped themes, in registration order", async () => {
    const { FULCTheme, pending } = await boot("nord");
    pending.nord();
    await tick();
    FULCTheme.register({ id: "zeta-extra", tokens: {} });
    FULCTheme.register({ id: "alpha-extra", tokens: {} });
    const all = FULCTheme.loadAll();
    await tick();
    for (const id of SHIPPED) if (id !== "nord") pending[id]();
    await all;
    expect(FULCTheme.list().map((e) => e.id)).toEqual([...SHIPPED, "zeta-extra", "alpha-extra"]);
  });
});
