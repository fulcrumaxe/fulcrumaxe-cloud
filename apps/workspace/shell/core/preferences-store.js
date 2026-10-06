// ── fulcrumaxe-os Preferences Store ───────────────────────────────────────────
// Client-side durable store for user preferences.
//
// Why this exists: `POST /api/preferences` is wired to `stub_success` in
// fulc_routes.rs. It answers {"success":true} and stores nothing, so every
// preference a user set — theme, font size, CRT toggle, prompt, avatar —
// reverted to the hardcoded defaults on the next reload while the UI reported
// that the save had worked. Reporting success for something that did not
// happen is the same defect class as the billing panels withheld in D#871.
//
// This module is what actually persists them, so the success the UI reports is
// true. The POST is still sent: when a real preferences backend lands it
// becomes authoritative and this drops back to being a cache. Until then this
// is the only store, and a caller that cannot write here is told so rather
// than being handed a `true` it did not earn.
//
// Scope is deliberately per-browser. That is a real limitation — preferences
// do not follow the user to another machine — but it is an honest one, and it
// matches how the desktop already persists icon positions and the wallpaper.

// D#37 WS-C2 criterion 11: persisted under storage-ns.js's fx:<ns>:
// namespace, not a raw localStorage key.
import { getItem, setItem } from "./storage-ns.js";

const STORAGE_KEY = 'preferences';

/**
 * Read every locally-stored preference. Always returns a plain object; a
 * missing, unreadable or malformed store reads as "nothing set" rather than
 * throwing, because a corrupt value must not be able to block boot.
 */
export function readStoredPreferences() {
  try {
    const raw = getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    // Private-mode / disabled storage / bad JSON — treat as empty.
    return {};
  }
}

/**
 * Persist one preference. Returns true only when the write actually landed —
 * callers report success to the user on the strength of this, so it must not
 * return true optimistically.
 */
export function storePreference(key, value) {
  const next = readStoredPreferences();
  next[key] = value;
  return setItem(STORAGE_KEY, JSON.stringify(next));
}
