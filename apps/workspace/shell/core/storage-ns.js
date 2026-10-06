// ── fulcrumaxe workspace Storage Namespace ─────────────────────────────────
// D#37 WS-C2 criterion 11: every localStorage key this fork writes is
// `fx:<storage_ns>:<name>`, where storage_ns is the opaque, per-account
// value GET /api/cloud/auth/me returns (an HMAC of the account id,
// never the raw id — see packages/core/src/auth). boot.js is the one
// caller that learns it: it calls setNamespace() right after a
// signed-in session is confirmed, before showDesktop() runs any code
// that might read or write a preference.
//
// Two modules (core/theme-layout.js, core/hot-corners.js) restore
// persisted state eagerly at script-parse time, before boot.js's async
// session check has had a chance to run at all. onNamespaceReady() lets
// them defer that one read until a namespace actually exists, instead
// of reading (and finding nothing under) an unnamespaced key.

export const PREFIX = 'fx:';

let _ns = null;
const _waiters = [];

export function getNamespace() {
  return _ns;
}

export function setNamespace(ns) {
  _ns = typeof ns === 'string' && ns ? ns : null;
  if (!_ns) return;
  const waiters = _waiters.splice(0, _waiters.length);
  waiters.forEach((cb) => {
    try { cb(); } catch (e) { console.error('FULCStorageNS: onNamespaceReady callback failed', e); }
  });
}

/**
 * Registers `cb` to run once a namespace is known. If one already is,
 * runs synchronously and immediately, so a caller never has to branch
 * on whether sign-in already happened by the time it asks.
 */
export function onNamespaceReady(cb) {
  if (_ns) {
    cb();
  } else {
    _waiters.push(cb);
  }
}

function namespacedKey(name) {
  return _ns ? PREFIX + _ns + ':' + name : null;
}

/** Returns null (never throws, never falls back to an unnamespaced key) when no namespace is set yet or storage is unavailable. */
export function getItem(name) {
  const k = namespacedKey(name);
  if (!k) return null;
  try { return window.localStorage.getItem(k); } catch (e) { return null; }
}

/** Returns false (a no-op) when no namespace is set yet or storage is unavailable/full. */
export function setItem(name, value) {
  const k = namespacedKey(name);
  if (!k) return false;
  try { window.localStorage.setItem(k, value); return true; } catch (e) { return false; }
}

export function removeItem(name) {
  const k = namespacedKey(name);
  if (!k) return;
  try { window.localStorage.removeItem(k); } catch (e) {}
}

/**
 * D#37 WS-C2 criterion 12 (sign-out): every `fx:<ns>:` key for EVERY
 * namespace this browser has ever seen — not just the active one, so a
 * stale namespace from a previous account can't survive either — plus
 * every unprefixed legacy `fulc*` key, plus sessionStorage in full.
 */
export function clearAllClientState() {
  try {
    const toRemove = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && (k.indexOf(PREFIX) === 0 || k.indexOf('fulc') === 0)) toRemove.push(k);
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch (e) {}
  try { window.sessionStorage.clear(); } catch (e) {}
  _ns = null;
}
