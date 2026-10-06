"use strict";
// ── localStorage key migration (D#922 PR-c, maintainer decision 5) ─────────
//
// The rename moved every browser-persisted key to the `fulc` stem. On first
// load after the upgrade, each key still under the pre-rename stem is copied
// to its new name when that name is absent, and the old key is deleted. A
// second load finds nothing to move.
//
// A classic script (no import/export) loaded as the FIRST <script> in
// index.html. Classic scripts such as apps/activation/activation.js read
// storage while the page is still parsing, before any module runs, so a
// module would be too late. It must not throw: a blocked or full storage
// (private window, quota) is logged, and the page carries on with whatever it
// can read. `window.FULCStorageKeyMigration` is the hook the vitest suite uses.
//
// The pre-rename stem exists only in LEGACY_STEM, which
// scripts/rename/RENAME-RULES.txt holds. Delete this file after one release.
(function () {
    const LEGACY_STEM = "jpos";
    const STEM = "fulc";
    // The shapes the identifiers pass renamed: `<stem>-x`, `<stem>_x`,
    // `<stem>.x`, `<stem>:x`, `<stem>X` (camel), each with optional leading
    // underscores.
    const LEGACY_KEY = new RegExp(`^(_*)${LEGACY_STEM}(?=[-_.:A-Z])`);
    function migratedKeyName(key) {
        const m = LEGACY_KEY.exec(key);
        return m ? `${m[1]}${STEM}${key.slice(m[0].length)}` : null;
    }
    function migrateStorageKeys(storage) {
        const result = { copied: [], superseded: [] };
        const keys = [];
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k !== null)
                keys.push(k);
        }
        for (const oldKey of keys) {
            const newKey = migratedKeyName(oldKey);
            if (newKey === null)
                continue;
            const value = storage.getItem(oldKey);
            if (value === null)
                continue;
            if (storage.getItem(newKey) === null) {
                // Copy first; if this throws (quota) the old key is left in place.
                storage.setItem(newKey, value);
                result.copied.push(oldKey);
            }
            else {
                result.superseded.push(oldKey);
            }
            storage.removeItem(oldKey);
        }
        return result;
    }
    if (typeof window === "undefined")
        return;
    window.FULCStorageKeyMigration = { migratedKeyName, migrateStorageKeys };
    try {
        const { copied, superseded } = migrateStorageKeys(window.localStorage);
        if (copied.length || superseded.length) {
            console.info(`[storage-key-migration] moved ${copied.length} key(s) to the ${STEM} names` +
                (superseded.length ? `, dropped ${superseded.length} superseded` : ""));
        }
    }
    catch (err) {
        console.warn("[storage-key-migration] skipped:", err);
    }
})();
//# sourceMappingURL=storage-key-migration.js.map