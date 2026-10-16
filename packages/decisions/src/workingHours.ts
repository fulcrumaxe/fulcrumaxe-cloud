/**
 * Working-hours windows for escalation routes (D#7 AAP-b1, C18 section 3a). Pure (C1): the only thing it reads from outside its
 * arguments is the platform's `Intl` time-zone data, and it never reads the clock.
 *
 * A route's `hours` is an array of windows `{timeZone, days, start, end}`. `days` are ISO weekdays (1 Monday .. 7 Sunday); `start` and
 * `end` are 24-hour "HH:MM" wall-clock strings in the window's own IANA zone; a window never crosses midnight; `end` may be "24:00".
 * Windows may overlap and the working time is their union. An empty array means "always working", never "never".
 *
 * DST: times are wall-clock in the window's zone. A start time that does not exist on a spring-forward day moves to the first valid
 * instant after it (the instant the clocks jump). A repeated time on a fall-back day uses its first occurrence.
 */

export const HOURS_MAX_WINDOWS = 14;

export interface HoursWindow {
  readonly timeZone: string;
  /** Distinct ISO weekdays, 1 (Monday) to 7 (Sunday). */
  readonly days: readonly number[];
  /** "HH:MM", 24-hour, in `timeZone`. */
  readonly start: string;
  /** "HH:MM" or "24:00", after `start`. */
  readonly end: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;
/** Longest search for the next window start: a window with at least one day recurs within a week. */
const SEARCH_DAYS = 8;

/** Minutes after midnight for "HH:MM" (or "24:00" when `allow24`), or null when it is not that shape. */
export function parseClock(value: unknown, allow24: boolean): number | null {
  if (typeof value !== "string") return null;
  if (allow24 && value === "24:00") return 1440;
  const m = TIME_RE.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * True for an IANA zone name spelled the way the IANA database spells it. `Intl` also accepts other cases ("america/new_york") and numeric
 * offsets ("+05:00"); neither is an IANA zone name, so a route that names one is refused rather than stored. `Intl` resolves some valid
 * names to another spelling (Asia/Kolkata to Asia/Calcutta), so a name that differs from its resolved form is accepted only when every
 * part starts with a capital and no part is all capitals.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    const resolved = formatterFor(value).resolvedOptions().timeZone;
    if (resolved === value) return true;
    return value.split(/[/_]/).every((part) => /^[A-Z]/.test(part) && (part.length === 1 || part !== part.toUpperCase()));
  } catch {
    // fx-swallow-ok: Intl throws RangeError for an unknown zone, and "not a valid zone" is the answer here
    return false;
  }
}

interface Local {
  y: number;
  mo: number;
  d: number;
  secOfDay: number;
  /** ISO weekday, 1 (Monday) to 7 (Sunday). */
  isoDay: number;
  /** The wall-clock reading as if it were UTC, in whole seconds' worth of milliseconds. */
  asUtc: number;
}

function localOf(ms: number, timeZone: string): Local {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour") % 24;
  const secOfDay = h * 3600 + get("minute") * 60 + get("second");
  const asUtc = Date.UTC(y, mo - 1, d, h, get("minute"), get("second"));
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, mo, d, secOfDay, isoDay: dow === 0 ? 7 : dow, asUtc };
}

/** The zone's UTC offset at an instant, in milliseconds (whole seconds). */
function offsetAt(ms: number, timeZone: string): number {
  return localOf(ms, timeZone).asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock reading happens in a zone. On a fall-back day the reading occurs twice and the first occurrence is returned.
 * On a spring-forward day a reading in the skipped hour does not occur, and the instant the clocks jump is returned.
 */
function wallToInstant(timeZone: string, y: number, mo: number, d: number, minuteOfDay: number): number {
  const wanted = Date.UTC(y, mo - 1, d) + minuteOfDay * 60_000;
  const before = offsetAt(wanted - DAY_MS, timeZone);
  const after = offsetAt(wanted + DAY_MS, timeZone);
  const candidates = [...new Set([wanted - before, wanted - after])].sort((a, b) => a - b);
  for (const c of candidates) {
    if (c + offsetAt(c, timeZone) === wanted) return c;
  }
  // Skipped reading: search the one transition between the two candidates for the first instant already on the later offset.
  let lo = candidates[0] ?? wanted;
  let hi = candidates[candidates.length - 1] ?? wanted;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(mid, timeZone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

function windowParsed(w: HoursWindow): { startMin: number; endMin: number } | null {
  const startMin = parseClock(w.start, false);
  const endMin = parseClock(w.end, true);
  return startMin === null || endMin === null || startMin >= endMin ? null : { startMin, endMin };
}

function usableWindows(hours: readonly HoursWindow[]): { w: HoursWindow; startMin: number; endMin: number }[] {
  const out: { w: HoursWindow; startMin: number; endMin: number }[] = [];
  for (const w of hours) {
    const p = windowParsed(w);
    if (!p || !Array.isArray(w.days) || w.days.length === 0) continue;
    try {
      formatterFor(w.timeZone);
    } catch {
      // fx-swallow-ok: a window with an unusable zone is ignored (a validated route cannot have one); the planner stays total
      continue;
    }
    out.push({ w, ...p });
  }
  return out;
}

/**
 * Moves an instant to working time. An instant inside any window stays; one outside every window moves to the earliest later window start.
 * An empty `hours` (or one with no usable window) is "always working". Returns null only when no window start exists within the search span,
 * which a validated route cannot produce.
 */
export function deferToWorkingHours(hours: readonly HoursWindow[], ms: number): number | null {
  const windows = usableWindows(hours);
  if (windows.length === 0) return ms;
  for (const { w, startMin, endMin } of windows) {
    const l = localOf(ms, w.timeZone);
    if (w.days.includes(l.isoDay) && l.secOfDay >= startMin * 60 && l.secOfDay < endMin * 60) return ms;
  }
  let best: number | null = null;
  for (const { w, startMin } of windows) {
    const base = localOf(ms, w.timeZone);
    for (let k = 0; k < SEARCH_DAYS; k += 1) {
      const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + k));
      const dow = day.getUTCDay();
      if (!w.days.includes(dow === 0 ? 7 : dow)) continue;
      const start = wallToInstant(w.timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), startMin);
      if (start > ms && (best === null || start < best)) best = start;
    }
  }
  return best;
}
