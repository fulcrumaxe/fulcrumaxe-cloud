// ── FULC* app-SDK globals (D#922 PR-c, maintainer decision 5) ───────────────
//
// `docs/typescript-apps.md` tells app authors to use the window manager, the
// app registry, the SDK namespace and the baseapp-id marker through globals on
// `window`. Those gain FULC* names: FULCWM, FULCApps, FULC and
// __FULC_BASEAPP_ID__. The pre-rename names keep working as deprecated aliases,
// so no published bundle breaks.
//
// Both names are the same property. Each FULC* name is an accessor onto the
// pre-rename one, whichever side a module assigns first. The text rename of the
// pre-rename spellings belongs to the frozen pass (PR-d), which flips which one
// is stored. A name that already exists as its own property is left untouched.
//
// The pre-rename stem exists only in LEGACY_STEM, which
// scripts/rename/RENAME-RULES.txt holds.
const LEGACY_STEM = "JPOS";
const STEM = "FULC";
/** [current, pre-rename] global name pairs. */
export function aliasPairs() {
    const pairs = ["WM", "Apps", ""].map((suffix) => [
        `${STEM}${suffix}`,
        `${LEGACY_STEM}${suffix}`,
    ]);
    pairs.push([`__${STEM}_BASEAPP_ID__`, `__${LEGACY_STEM}_BASEAPP_ID__`]);
    return pairs;
}
/** Define each current name as an alias of its pre-rename twin on `target`. */
export function installGlobalAliases(target) {
    const bag = target;
    const installed = [];
    for (const [current, legacy] of aliasPairs()) {
        if (Object.prototype.hasOwnProperty.call(bag, current))
            continue;
        Object.defineProperty(bag, current, {
            configurable: true,
            enumerable: false,
            get: () => bag[legacy],
            set: (value) => {
                bag[legacy] = value;
            },
        });
        installed.push(current);
    }
    return installed;
}
if (typeof window !== "undefined") {
    installGlobalAliases(window);
}
//# sourceMappingURL=fulc-global-aliases.js.map