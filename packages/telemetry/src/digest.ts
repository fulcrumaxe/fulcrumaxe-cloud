import type { ErrorClass } from "./reportError.js";

/**
 * The rules of the operator's error digest (D#454 H1f), as pure functions over rows that were already read. No I/O: the
 * route reads `error_events` and `reconcile_jobs`, hands the rows here, and returns what comes back.
 *
 * A row is one (hour, class) with a count, as the sink stores it. A "window" is the last `windowHours` hours; a bucket
 * belongs to it when the hour it opens overlaps the window. Everything in the result is a coded label, a number or a
 * timestamp: a class is four validated labels, so the digest has nothing a name or a secret could ride on.
 *
 * Rules:
 *   - classes: every class seen in the window, with its count and its first and last time seen.
 *   - new: a class seen in the window and in none of the 7 days before it.
 *   - jump: one hour of one class with a count of at least JUMP_MIN_HOURLY that is also at least JUMP_FACTOR times the
 *     median of that class's 24 hours before it (an hour with no row counts as 0, so the median of a quiet class is 0).
 *   - overflow: the reserved class the database writes once the per-hour cap on distinct classes is reached, whenever present.
 *   - lap breach: a reconciler job whose last full pass is more than twice its interval ago (the lap time arrives computed).
 *
 * Each alert carries a `key` that is stable for the same finding, so a caller that posts alerts can skip one it has posted.
 */

export const DIGEST_DEFAULT_WINDOW_HOURS = 24;
export const DIGEST_MAX_WINDOW_HOURS = 48;
/** How far before the window a class must be absent to count as new. */
export const NEW_CLASS_LOOKBACK_HOURS = 24 * 7;
export const JUMP_MIN_HOURLY = 10;
export const JUMP_FACTOR = 5;
export const JUMP_BASELINE_HOURS = 24;
/** The class list is cut here (largest counts first) so the answer stays small; the cut is reported. */
export const DIGEST_MAX_CLASSES = 200;
export const DIGEST_MAX_JUMPS = 50;

const HOUR_MS = 3_600_000;

/** How many hours of rows the reader must fetch for a window: the window plus the longer of the two look-backs. */
export function digestLookbackHours(windowHours: number): number {
  return windowHours + Math.max(NEW_CLASS_LOOKBACK_HOURS, JUMP_BASELINE_HOURS);
}

export interface ErrorEventRow extends ErrorClass {
  /** The hour the row covers, at its start. */
  bucket: Date;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** What the digest needs of a reconciler job's lap time (the shape of @fx/reconcile's LapTime, without its other fields). */
export interface DigestLap {
  name: string;
  intervalSeconds: number;
  lapSeconds: number;
  neverCompleted: boolean;
  breach: boolean;
}

export interface DigestClass extends ErrorClass {
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface DigestJump extends ErrorClass {
  /** The hour that jumped, at its start. */
  hour: string;
  count: number;
  /** The median hourly count of the 24 hours before it. */
  baselineMedian: number;
}

export type DigestAlertKind = "new_class" | "jump" | "overflow" | "lap_breach";

export interface DigestAlert {
  kind: DigestAlertKind;
  key: string;
  /** A fixed sentence, never built from row content. */
  note: string;
}

export interface Digest {
  generatedAt: string;
  windowHours: number;
  windowStart: string;
  totalCount: number;
  classTotal: number;
  classesTruncated: boolean;
  classes: DigestClass[];
  newClasses: DigestClass[];
  jumps: DigestJump[];
  overflow: { count: number; firstSeen: string; lastSeen: string } | null;
  laps: DigestLap[];
  alerts: DigestAlert[];
}

export interface BuildDigestInput {
  rows: readonly ErrorEventRow[];
  laps: readonly DigestLap[];
  /** Database time, in ms. */
  now: number;
  windowHours?: number;
}

const classKey = (c: ErrorClass): string => [c.service, c.route, c.stage, c.code].join("\u0000");
const labelKey = (c: ErrorClass): string => [c.service, c.route, c.stage, c.code].join("|");
const isOverflow = (c: ErrorClass): boolean => c.service === "platform" && c.stage === "overflow" && c.code === "error_overflow";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildDigest(input: BuildDigestInput): Digest {
  const windowHours = input.windowHours ?? DIGEST_DEFAULT_WINDOW_HOURS;
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > DIGEST_MAX_WINDOW_HOURS) {
    throw new RangeError(`windowHours must be a whole number from 1 to ${DIGEST_MAX_WINDOW_HOURS}`);
  }
  const windowStart = input.now - windowHours * HOUR_MS;
  // A bucket belongs to the window when its hour overlaps it; the earlier buckets are "before".
  const inWindow = (r: ErrorEventRow): boolean => r.bucket.getTime() > windowStart - HOUR_MS;
  const beforeFrom = windowStart - NEW_CLASS_LOOKBACK_HOURS * HOUR_MS;

  const classes = new Map<string, DigestClass>();
  const seenBefore = new Set<string>();
  const hourly = new Map<string, Map<number, number>>();
  const labels = new Map<string, ErrorClass>();
  let overflow = null as Digest["overflow"];
  let overflowLast = 0;
  let totalCount = 0;

  for (const r of input.rows) {
    const key = classKey(r);
    const at = r.bucket.getTime();
    // The per-class hourly series feeds the jump baseline, whichever side of the window the hour is on.
    const series = hourly.get(key) ?? new Map<number, number>();
    series.set(at, (series.get(at) ?? 0) + r.count);
    hourly.set(key, series);
    labels.set(key, { service: r.service, route: r.route, stage: r.stage, code: r.code });

    if (!inWindow(r)) {
      if (at >= beforeFrom) seenBefore.add(key);
      continue;
    }
    totalCount += r.count;
    const first = r.firstSeenAt.toISOString();
    const last = r.lastSeenAt.toISOString();
    const have = classes.get(key);
    if (have) {
      have.count += r.count;
      if (first < have.firstSeen) have.firstSeen = first;
      if (last > have.lastSeen) have.lastSeen = last;
    } else {
      classes.set(key, { service: r.service, route: r.route, stage: r.stage, code: r.code, count: r.count, firstSeen: first, lastSeen: last });
    }
    if (isOverflow(r)) {
      overflow = overflow
        ? { count: overflow.count + r.count, firstSeen: first < overflow.firstSeen ? first : overflow.firstSeen, lastSeen: last > overflow.lastSeen ? last : overflow.lastSeen }
        : { count: r.count, firstSeen: first, lastSeen: last };
      overflowLast = Math.max(overflowLast, at);
    }
  }

  const all = [...classes.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
  const newClasses = all.filter(([key]) => !seenBefore.has(key)).map(([, c]) => c);

  const jumps: DigestJump[] = [];
  for (const [key, series] of hourly) {
    const label = labels.get(key)!;
    for (const [at, n] of series) {
      if (at <= windowStart - HOUR_MS || n < JUMP_MIN_HOURLY) continue;
      const before: number[] = [];
      for (let h = 1; h <= JUMP_BASELINE_HOURS; h++) before.push(series.get(at - h * HOUR_MS) ?? 0);
      const base = median(before);
      if (n >= JUMP_FACTOR * base) jumps.push({ ...label, hour: new Date(at).toISOString(), count: n, baselineMedian: base });
    }
  }
  jumps.sort((a, b) => (a.hour < b.hour ? 1 : a.hour > b.hour ? -1 : b.count - a.count));

  const day = new Date(input.now).toISOString().slice(0, 10);
  const alerts: DigestAlert[] = [
    ...newClasses.map((c): DigestAlert => ({ kind: "new_class", key: `new:${labelKey(c)}`, note: "A class first seen in this window." })),
    ...jumps.map((j): DigestAlert => ({ kind: "jump", key: `jump:${labelKey(j)}@${j.hour}`, note: "An hour with at least 5 times its usual count." })),
    ...(overflow ? [{ kind: "overflow", key: `overflow:${new Date(overflowLast).toISOString()}`, note: "More distinct error classes than the hourly cap; the extra were counted together." } satisfies DigestAlert] : []),
    ...input.laps.filter((l) => l.breach).map((l): DigestAlert => ({ kind: "lap_breach", key: `lap:${l.name}:${day}`, note: "The last full pass is more than twice the interval ago: the job's budget is too small for the estate." })),
  ];

  return {
    generatedAt: new Date(input.now).toISOString(),
    windowHours,
    windowStart: new Date(windowStart).toISOString(),
    totalCount,
    classTotal: all.length,
    classesTruncated: all.length > DIGEST_MAX_CLASSES,
    classes: all.slice(0, DIGEST_MAX_CLASSES).map(([, c]) => c),
    newClasses,
    jumps: jumps.slice(0, DIGEST_MAX_JUMPS),
    overflow,
    laps: input.laps.map((l) => ({ ...l })),
    alerts,
  };
}
