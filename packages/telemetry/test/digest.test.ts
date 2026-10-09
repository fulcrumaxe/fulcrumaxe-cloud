import { describe, expect, it } from "vitest";
import {
  DIGEST_MAX_CLASSES,
  JUMP_FACTOR,
  JUMP_MIN_HOURLY,
  buildDigest,
  digestLookbackHours,
  type DigestLap,
  type ErrorEventRow,
} from "../src/digest.js";

const HOUR = 3_600_000;
/** 2026-10-08 10:30 UTC: mid-hour, so the open hour is a partial bucket. */
const NOW = Date.UTC(2026, 9, 8, 10, 30);
const THIS_HOUR = Date.UTC(2026, 9, 8, 10);

const cls = { service: "web", route: "/api/x", stage: "sync", code: "mint_failed" };

/** A row `hoursAgo` hours before the open hour. */
function row(hoursAgo: number, count: number, over: Partial<ErrorEventRow> = {}): ErrorEventRow {
  const bucket = new Date(THIS_HOUR - hoursAgo * HOUR);
  return { ...cls, bucket, count, firstSeenAt: new Date(bucket.getTime() + 60_000), lastSeenAt: new Date(bucket.getTime() + 120_000), ...over };
}

const lap = (over: Partial<DigestLap> = {}): DigestLap => ({ name: "github_repos", intervalSeconds: 21_600, lapSeconds: 3_600, neverCompleted: false, breach: false, ...over });

describe("buildDigest: classes", () => {
  it("sums a class across hours, with its first and last time seen, and ignores hours outside the window", () => {
    const d = buildDigest({ now: NOW, laps: [], rows: [row(0, 2), row(3, 5), row(30, 100)] });
    expect(d.windowHours).toBe(24);
    expect(d.classes).toHaveLength(1);
    expect(d.classes[0]).toMatchObject({ ...cls, count: 7 });
    expect(d.classes[0]!.firstSeen).toBe(new Date(THIS_HOUR - 3 * HOUR + 60_000).toISOString());
    expect(d.classes[0]!.lastSeen).toBe(new Date(THIS_HOUR + 120_000).toISOString());
    expect(d.totalCount).toBe(7);
  });

  it("counts the hour that contains the start of the window, and not the hour before it", () => {
    // NOW is 10:30; the window opens at 10:30 yesterday, inside the bucket 10:00 yesterday (24 hours before the open hour).
    const d = buildDigest({ now: NOW, laps: [], rows: [row(24, 4), row(25, 9)] });
    expect(d.totalCount).toBe(4);
  });

  it("orders the largest class first and cuts the list at the cap, saying so", () => {
    const rows: ErrorEventRow[] = [];
    for (let i = 0; i < DIGEST_MAX_CLASSES + 5; i++) rows.push(row(1, i + 1, { code: `code_${String(i).padStart(3, "0")}` }));
    const d = buildDigest({ now: NOW, laps: [], rows });
    expect(d.classTotal).toBe(DIGEST_MAX_CLASSES + 5);
    expect(d.classes).toHaveLength(DIGEST_MAX_CLASSES);
    expect(d.classesTruncated).toBe(true);
    expect(d.classes[0]!.count).toBe(DIGEST_MAX_CLASSES + 5);
  });

  it("an empty window is an empty digest with no alert", () => {
    const d = buildDigest({ now: NOW, laps: [lap()], rows: [] });
    expect(d).toMatchObject({ totalCount: 0, classTotal: 0, classes: [], newClasses: [], jumps: [], overflow: null, alerts: [] });
  });

  it("refuses a window outside 1 to 48 whole hours", () => {
    for (const windowHours of [0, -1, 49, 1.5, Number.NaN]) expect(() => buildDigest({ now: NOW, laps: [], rows: [], windowHours })).toThrow(RangeError);
    expect(() => buildDigest({ now: NOW, laps: [], rows: [], windowHours: 48 })).not.toThrow();
  });

  it("asks the reader for the window plus the 7 day look-back", () => {
    expect(digestLookbackHours(24)).toBe(24 + 168);
  });
});

describe("buildDigest: new classes", () => {
  it("a class first seen in the window is new; one that also appeared in the 7 days before is not", () => {
    const old = { code: "old_code" };
    const d = buildDigest({ now: NOW, laps: [], rows: [row(2, 1), row(2, 1, old), row(24 * 3, 1, old)] });
    expect(d.newClasses.map((c) => c.code)).toEqual(["mint_failed"]);
    expect(d.alerts.filter((a) => a.kind === "new_class").map((a) => a.key)).toEqual(["new:web|/api/x|sync|mint_failed"]);
  });

  it("a class last seen more than 7 days before the window is new again", () => {
    const d = buildDigest({ now: NOW, laps: [], rows: [row(2, 1), row(24 + 24 * 8, 1)] });
    expect(d.newClasses).toHaveLength(1);
  });

  it("the edge: seen exactly at the start of the 7 day look-back is not new", () => {
    // The window opens at 10:30 yesterday; the look-back reaches 7 days before that.
    const edge = row(24 + 24 * 7, 1); // the 10:00 bucket 8 days ago... one hour before the look-back opens
    const inside = row(24 + 24 * 7 - 1, 1);
    expect(buildDigest({ now: NOW, laps: [], rows: [row(2, 1), edge] }).newClasses).toHaveLength(1);
    expect(buildDigest({ now: NOW, laps: [], rows: [row(2, 1), inside] }).newClasses).toHaveLength(0);
  });
});

describe("buildDigest: jumps", () => {
  const steady = (hourly: number): ErrorEventRow[] => Array.from({ length: 50 }, (_, i) => row(i + 1, hourly));

  it("states the rule it tests: at least 10 an hour and at least 5 times the median of the 24 hours before", () => {
    expect(JUMP_MIN_HOURLY).toBe(10);
    expect(JUMP_FACTOR).toBe(5);
  });

  it("flags an hour at exactly 5 times the median (and at least 10), not one below it", () => {
    // Median 3: needs 15.
    const at15 = buildDigest({ now: NOW, laps: [], rows: [...steady(3), row(0, 15)] });
    expect(at15.jumps).toEqual([{ ...cls, hour: new Date(THIS_HOUR).toISOString(), count: 15, baselineMedian: 3 }]);
    expect(at15.alerts.find((a) => a.kind === "jump")!.key).toBe(`jump:web|/api/x|sync|mint_failed@${new Date(THIS_HOUR).toISOString()}`);
    const at14 = buildDigest({ now: NOW, laps: [], rows: [...steady(3), row(0, 14)] });
    expect(at14.jumps).toEqual([]);
  });

  it("needs 10 an hour even when 5 times the median is lower", () => {
    // Median 1: 5x is 5, but 9 is under the floor of 10.
    expect(buildDigest({ now: NOW, laps: [], rows: [...steady(1), row(0, 9)] }).jumps).toEqual([]);
    expect(buildDigest({ now: NOW, laps: [], rows: [...steady(1), row(0, 10)] }).jumps).toHaveLength(1);
  });

  it("an hour with no row counts as 0, so a quiet class jumps at 10", () => {
    const d = buildDigest({ now: NOW, laps: [], rows: [row(1, 1), row(0, 10)] });
    expect(d.jumps).toHaveLength(1);
    expect(d.jumps[0]!.baselineMedian).toBe(0);
  });

  it("a steadily noisy class does not jump", () => {
    expect(buildDigest({ now: NOW, laps: [], rows: [...steady(40), row(0, 60)] }).jumps).toEqual([]);
  });

  it("reads the baseline across the window start, and judges only hours inside the window", () => {
    // A jump 30 hours ago is outside the window; the same class's quiet hours around it are only a baseline.
    const d = buildDigest({ now: NOW, laps: [], rows: [row(30, 500), row(2, 1)] });
    expect(d.jumps).toEqual([]);
  });

  it("reports each jumping hour of each class once", () => {
    const other = { code: "other_code" };
    const d = buildDigest({ now: NOW, laps: [], rows: [row(0, 20), row(5, 20), row(0, 30, other)] });
    expect(d.jumps).toHaveLength(3);
    expect(new Set(d.alerts.filter((a) => a.kind === "jump").map((a) => a.key)).size).toBe(3);
  });
});

describe("buildDigest: overflow and lap time", () => {
  const overflowRow = (hoursAgo: number, count: number): ErrorEventRow =>
    row(hoursAgo, count, { service: "platform", route: "/", stage: "overflow", code: "error_overflow" });

  it("reports the overflow class whenever it is present, summed over the window", () => {
    const d = buildDigest({ now: NOW, laps: [], rows: [overflowRow(1, 4), overflowRow(3, 6)] });
    expect(d.overflow).toMatchObject({ count: 10 });
    expect(d.alerts.map((a) => a.kind)).toContain("overflow");
  });

  it("no overflow row, no overflow; a look-alike class is not the overflow class", () => {
    expect(buildDigest({ now: NOW, laps: [], rows: [row(1, 3)] }).overflow).toBeNull();
    const imposter = row(1, 3, { service: "web", route: "/", stage: "overflow", code: "error_overflow" });
    expect(buildDigest({ now: NOW, laps: [], rows: [imposter] }).overflow).toBeNull();
    expect(buildDigest({ now: NOW, laps: [], rows: [overflowRow(40, 3)] }).overflow).toBeNull();
  });

  it("alerts on a lap-time breach only, once per job per day, and lists every job's lap", () => {
    const laps = [lap(), lap({ name: "stripe_subscriptions", lapSeconds: 90_000, breach: true }), lap({ name: "never_done", neverCompleted: true, lapSeconds: 999_999, breach: true })];
    const d = buildDigest({ now: NOW, laps, rows: [] });
    expect(d.laps).toHaveLength(3);
    expect(d.alerts.map((a) => a.key)).toEqual(["lap:stripe_subscriptions:2026-10-08", "lap:never_done:2026-10-08"]);
  });

  it("an alert note is a fixed sentence: nothing from a row reaches it", () => {
    const d = buildDigest({ now: NOW, laps: [], rows: [row(0, 99, { code: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })] });
    for (const a of d.alerts) expect(a.note).not.toMatch(/ghp_/);
  });
});
