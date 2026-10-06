// apps/workspace/test/heritage-shell.test.mjs
//
// D#37 Correction C19 (discussioncomment 18606574), task WS-TH1, C19b
// criterion 4 (technical architect concern 1): core/heritage-shell.js's
// activate() used to set `_current` only AFTER adapter.activate() returned
// -- so a throwing activate() left `_current` at its previous (often null)
// value, and a LATER deactivate() call (`if (!this._current) return;`)
// silently skipped tearing down whatever the throwing adapter had already
// built. That is the mechanism behind the observed "Aero kept orchard"
// bug: applying Cupertino+ (heritage-adapter "orchard") while its
// adapter's activate() throws (which it did, historically, under the
// Trusted Types sinks WS-TH1's other criteria remove) left a partial
// orchard DOM/stylesheet in place; switching to Aero+ (no heritage
// adapter at all, so the `fulc-theme-change` listener calls
// FULCHeritage.deactivate() directly, never activate()) found `_current`
// unset and did nothing.
//
// This project's vitest environment is "node" (vitest.workspace.ts), not
// jsdom -- apps/workspace carries no jsdom dependency. heritage-shell.js
// only ever touches `document.body.dataset` (plain-object property
// semantics -- no real DOM API needed) and
// `document.addEventListener`/`dispatchEvent` (covered by Node's own
// built-in EventTarget/CustomEvent, available without jsdom since Node
// 19). A minimal stub `document` below is enough to import and exercise
// the real module; nothing here needs jsdom.
//
// The fake adapters below stand in for orchard/crystal's real
// activate()/deactivate() (their own DOM/stylesheet teardown is exercised
// live by e2e/heritage-themes.spec.ts against a real browser) -- each
// tracks its own "mounted"/"stylesheet present" flags so a test can assert
// FULCHeritage's contract (does deactivate() actually get called? is
// body[data-heritage] cleared? is `_current` reset?) without a real DOM
// tree to inspect.

import { beforeEach, describe, expect, it, vi } from "vitest";

let FULCHeritage;
let document;

beforeEach(async () => {
  document = Object.assign(new EventTarget(), { body: { dataset: {} } });
  globalThis.document = document;
  // Re-import fresh each test: heritage-shell.js's module-level `_adapters`/
  // `_current` state (and its `document.addEventListener` registration)
  // must not leak between tests. Vitest's module registry is per-test-file
  // by default, not per-test, so `vi.resetModules()` forces a fresh module
  // instance (and a fresh `document.addEventListener` binding against this
  // test's own stub `document`) every time.
  vi.resetModules();
  ({ FULCHeritage } = await import("../shell/core/heritage-shell.js"));
});

function makeAdapter({ throwOnActivate = false } = {}) {
  const state = { mounted: false, stylesheetPresent: false, deactivateCalls: 0 };
  return {
    state,
    activate() {
      // A real adapter builds its DOM/injects its stylesheet before doing
      // anything that could throw (see orchard-adapter.js/crystal-adapter.js:
      // injectStyles() then buildMenuBar()/buildTaskbar() etc.) -- mirrored
      // here so a throw leaves the same kind of partial state a real
      // Trusted-Types-blocked sink would have left before this task's fix.
      state.stylesheetPresent = true;
      state.mounted = true;
      if (throwOnActivate) {
        throw new Error("simulated adapter activate() failure");
      }
    },
    deactivate() {
      state.deactivateCalls += 1;
      state.mounted = false;
      state.stylesheetPresent = false;
    },
  };
}

describe("D#37 WS-TH1 criterion 4: FULCHeritage activate()/deactivate() hardening", () => {
  it("a throwing adapter.activate() does not escape FULCHeritage.activate(), and leaves no trace", () => {
    const orchard = makeAdapter({ throwOnActivate: true });
    FULCHeritage.register("orchard", orchard);

    expect(() => FULCHeritage.activate("orchard")).not.toThrow();

    expect(document.body.dataset.heritage).toBeUndefined();
    expect(FULCHeritage._current).toBeNull();
    // deactivate() ran as part of activate()'s own catch block -- the
    // adapter's own teardown (stylesheet removal, DOM removal) fired even
    // though activate() itself never returned normally.
    expect(orchard.state.deactivateCalls).toBe(1);
    expect(orchard.state.mounted).toBe(false);
    expect(orchard.state.stylesheetPresent).toBe(false);
  });

  it("applying a different, working theme after a throwing activate() succeeds cleanly", () => {
    const orchard = makeAdapter({ throwOnActivate: true });
    const crystal = makeAdapter();
    FULCHeritage.register("orchard", orchard);
    FULCHeritage.register("crystal", crystal);

    FULCHeritage.activate("orchard"); // throws internally, recovers
    expect(() => FULCHeritage.activate("crystal")).not.toThrow();

    expect(document.body.dataset.heritage).toBe("crystal");
    expect(FULCHeritage._current).toBe("crystal");
    expect(crystal.state.mounted).toBe(true);
    expect(crystal.state.stylesheetPresent).toBe(true);
    // orchard was never left "current" by the failed activation, so
    // switching to crystal did not (and could not) call orchard's
    // deactivate() a second time.
    expect(orchard.state.deactivateCalls).toBe(1);
  });

  it('switching to a theme with no heritage adapter (the Aero+/Yaru+ shape) after a throwing activate() still tears down -- the "Aero kept orchard" case', () => {
    const orchard = makeAdapter({ throwOnActivate: true });
    FULCHeritage.register("orchard", orchard);

    FULCHeritage.activate("orchard"); // throws internally, recovers
    // Mirrors the real `fulc-theme-change` listener's else-branch for a
    // theme with no heritage-adapter (heritage-shell.js's own bottom
    // block): FULCHeritage.deactivate() is called directly, never
    // activate().
    expect(() => FULCHeritage.deactivate()).not.toThrow();

    expect(document.body.dataset.heritage).toBeUndefined();
    expect(FULCHeritage._current).toBeNull();
    expect(orchard.state.mounted).toBe(false);
    expect(orchard.state.stylesheetPresent).toBe(false);
  });

  it("a normal (non-throwing) activate() still works and is torn down by a later deactivate()", () => {
    const crystal = makeAdapter();
    FULCHeritage.register("crystal", crystal);

    FULCHeritage.activate("crystal");
    expect(document.body.dataset.heritage).toBe("crystal");
    expect(crystal.state.mounted).toBe(true);

    FULCHeritage.deactivate();
    expect(document.body.dataset.heritage).toBeUndefined();
    expect(FULCHeritage._current).toBeNull();
    expect(crystal.state.mounted).toBe(false);
    expect(crystal.state.deactivateCalls).toBe(1);
  });

  it("a throwing adapter.deactivate() (during activate()'s own recovery) still clears dataset/_current", () => {
    const flaky = {
      state: { deactivateThrew: false },
      activate() {
        throw new Error("simulated activate() failure");
      },
      deactivate() {
        this.state.deactivateThrew = true;
        throw new Error("simulated deactivate() failure too");
      },
    };
    FULCHeritage.register("flaky", flaky);

    expect(() => FULCHeritage.activate("flaky")).not.toThrow();
    expect(flaky.state.deactivateThrew).toBe(true);
    expect(document.body.dataset.heritage).toBeUndefined();
    expect(FULCHeritage._current).toBeNull();
  });

  it("the fulc-theme-change listener drives activate()/deactivate() exactly as production does", () => {
    const orchard = makeAdapter();
    FULCHeritage.register("orchard", orchard);

    document.dispatchEvent(
      new CustomEvent("fulc-theme-change", { detail: { current: { "heritage-adapter": "orchard" } } }),
    );
    expect(document.body.dataset.heritage).toBe("orchard");
    expect(orchard.state.mounted).toBe(true);

    document.dispatchEvent(new CustomEvent("fulc-theme-change", { detail: { current: {} } }));
    expect(document.body.dataset.heritage).toBeUndefined();
    expect(orchard.state.mounted).toBe(false);
  });
});
