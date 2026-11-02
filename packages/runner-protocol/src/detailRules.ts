/**
 * The detail table's rules for a path and a branch name (migrations 0957 and 0948), as ONE predicate both sides use: the pipeline filters what it stores with them, and the
 * merge report's conflict facts are held to them, so a value one side takes the other can never refuse. The same corpus runs through these and through the SQL functions
 * (the pipeline's detailChecks.pg.test.ts). `[[:cntrl:]]` is read as C0, DEL and C1. Pure; no I/O.
 */
const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
// Wider than the SQL `[[:space:]]` on purpose (no-break spaces too): a ref the table would take may be dropped, one it would refuse never passes.
const SPACE = /[\s\u0085\u180e]/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
/** True when the string has no lone surrogate (it survives a round trip through UTF-8). */
const wellFormed = (s: string): boolean => decoder.decode(encoder.encode(s)) === s;

export function isDetailPath(p: unknown): p is string {
  if (typeof p !== "string" || p === "" || !wellFormed(p) || Array.from(p).length > 512 || encoder.encode(p).length > 1024) return false;
  if (CNTRL.test(p) || /[\u0085\u2028\u2029\\]/.test(p)) return false;
  return !/^\//.test(p) && !/^~(\/|$)/.test(p) && !/^[A-Za-z]:\//.test(p) && !/(^|\/)(\.|\.\.)?(\/|$)/.test(p);
}

export function isDetailRef(r: unknown): r is string {
  if (typeof r !== "string" || !wellFormed(r) || r === "" || encoder.encode(r).length > 255) return false;
  return !CNTRL.test(r) && !SPACE.test(r) && !r.includes("..") && !r.startsWith("-") && !/[~^:?*[\\]/.test(r);
}
