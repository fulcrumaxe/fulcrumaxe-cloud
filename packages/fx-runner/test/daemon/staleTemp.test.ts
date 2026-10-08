import { existsSync, lutimesSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeStaleLedgerTemp, STALE_TEMP_AGE_MS } from "../../src/daemon/staleTemp.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";

let dir: string;
let ledger: string;
/** A whole second, so the age arithmetic below is exact. */
const T0 = 1_800_000_000;
const now = (afterMs: number): Date => new Date(T0 * 1000 + afterMs);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxr-stale-"));
  ledger = path.join(dir, "jobs.ledger");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (name: string, mtimeSeconds = T0): string => {
  const target = path.join(dir, name);
  writeFileSync(target, "x");
  utimesSync(target, mtimeSeconds, mtimeSeconds);
  return target;
};

describe("stale leftovers next to the job ledger (C26 section 2 item 6)", () => {
  it("removes an exact-name temp file and an exact-name taken-over lock once they are more than ten minutes old", () => {
    const tmp = make("jobs.ledger.0123456789ab.tmp");
    const lock = make("jobs.ledger.lock.stale-fedcba987654");
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS + 1))).toBe(2);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it("the boundary: ten minutes exactly, and anything younger, survives", () => {
    const tmp = make("jobs.ledger.0123456789ab.tmp");
    const lock = make("jobs.ledger.lock.stale-fedcba987654");
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS))).toBe(0);
    expect(removeStaleLedgerTemp(ledger, now(0))).toBe(0);
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS - 1000))).toBe(0);
    expect([tmp, lock].map((f) => existsSync(f))).toEqual([true, true]);
  });

  it("a link with a matching name survives, and so does what it points at", () => {
    const outside = make("outside-target", T0 - 3600);
    const link = path.join(dir, "jobs.ledger.0123456789ab.tmp");
    symlinkSync(outside, link);
    lutimesSync(link, T0 - 3600, T0 - 3600);
    const dangling = path.join(dir, "jobs.ledger.lock.stale-fedcba987654");
    symlinkSync(path.join(dir, "nowhere"), dangling);
    lutimesSync(dangling, T0 - 3600, T0 - 3600);
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS + 1))).toBe(0);
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["jobs.ledger.0123456789ab.tmp", "jobs.ledger.lock.stale-fedcba987654", "outside-target"]);
  });

  it("a directory with a matching name survives, with what is inside it", () => {
    const sub = path.join(dir, "jobs.ledger.0123456789ab.tmp");
    mkdirSync(sub);
    const inner = path.join(sub, "inner");
    writeFileSync(inner, "x");
    utimesSync(sub, T0 - 3600, T0 - 3600);
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS + 1))).toBe(0);
    expect(existsSync(inner)).toBe(true);
  });

  it("every other name survives, however old: the ledger, the live lock, a lock's publish temp, a moved-aside ledger, near misses and other files", () => {
    const names = [
      "jobs.ledger",
      "jobs.ledger.lock",
      "jobs.ledger.lock.0123456789ab.tmp",
      "jobs.ledger.damaged-1-abc",
      "jobs.ledger.0123456789AB.tmp",
      "jobs.ledger.0123456789a.tmp",
      "jobs.ledger.0123456789abc.tmp",
      "jobs.ledger.0123456789ab.tmp.1",
      "jobs.ledger.tmp",
      "jobs.ledger.lock.stale-",
      "jobs.ledger.lock.stale-fedcba98765",
      "jobs.ledger.lock.stale-fedcba987654.x",
      "x.jobs.ledger.0123456789ab.tmp",
      "other.ledger.0123456789ab.tmp",
      "registration.json.0123456789ab.tmp",
      "sessions.json.0123456789ab.tmp",
    ];
    for (const name of names) make(name, T0 - 86_400);
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS + 1))).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([...names].sort());
  });

  it("only the ledger's own directory is looked at, not a subdirectory, and a missing directory has nothing to remove", () => {
    const sub = path.join(dir, "sub");
    mkdirSync(sub);
    const nested = path.join(sub, "jobs.ledger.0123456789ab.tmp");
    writeFileSync(nested, "x");
    utimesSync(nested, T0 - 3600, T0 - 3600);
    expect(removeStaleLedgerTemp(ledger, now(STALE_TEMP_AGE_MS + 1))).toBe(0);
    expect(existsSync(nested)).toBe(true);
    expect(removeStaleLedgerTemp(path.join(dir, "gone", "jobs.ledger"), now(0))).toBe(0);
  });

  it("matches the names the ledger really writes: six random bytes in hex, which is twelve characters", () => {
    const source = readFileSync(path.join(PACKAGE_DIR, "src", "daemon", "ledger.ts"), "utf8");
    expect(source).toContain('const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;');
    expect(source).toContain('const aside = `${lock}.stale-${randomBytes(6).toString("hex")}`;');
  });
});
