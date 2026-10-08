import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileLedger, LedgerLockedError, type FileLedger } from "../../src/daemon/ledger.js";
import { ledgerOptions, pidIsAlive } from "../helpers/ledgerOptions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
// Ids with hex letters in them, so that lowercasing the id is observable: an upper-case spelling of this id is the same id.
const HEX = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let dir: string;
let file: string;
let open: FileLedger[];
/** A ledger that is closed again at the end of the test, so its lock does not outlive it. */
const ledgerAt = (target = file, now?: () => Date): FileLedger => {
  const ledger = createFileLedger(target, ledgerOptions(now));
  open.push(ledger);
  return ledger;
};
const idsInFile = (target = file): string[] => Object.keys(JSON.parse(readFileSync(target, "utf8")) as object).sort();
const asideOf = (): string[] => readdirSync(path.dirname(file)).filter((name) => name.startsWith("jobs.json.damaged-"));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxr-ledger-"));
  file = path.join(dir, "state", "jobs.json");
  open = [];
});
afterEach(() => {
  for (const ledger of open) ledger.close();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("the job-id ledger", () => {
  it("answers true once per id, whatever the case", () => {
    const ledger = ledgerAt();
    expect(ledger.claim(A)).toBe(true);
    expect(ledger.claim(A)).toBe(false);
    expect(ledger.claim(A.toUpperCase())).toBe(false);
    expect(ledger.claim(B)).toBe(true);
  });

  it("treats the same id in another case as the same id, also when it is in the file (an id with hex letters)", () => {
    const first = ledgerAt();
    expect(first.claim(HEX.toUpperCase())).toBe(true);
    expect(idsInFile()).toEqual([HEX]);
    expect(first.claim(HEX)).toBe(false);
    first.close();
    const restarted = ledgerAt();
    expect(restarted.claim(HEX.toUpperCase())).toBe(false);
    expect(restarted.claim(HEX)).toBe(false);
  });

  it("remembers across a restart: a new ledger on the same file refuses an id the old one took", () => {
    const first = ledgerAt();
    expect(first.claim(A)).toBe(true);
    first.close();
    const restarted = ledgerAt();
    expect(restarted.claim(A)).toBe(false);
    expect(restarted.claim(B)).toBe(true);
  });

  it("writes a 0600 file in a 0700 directory, holding ids and times only", () => {
    ledgerAt().claim(A);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(idsInFile()).toEqual([A]);
  });

  it("makes an existing directory 0700 too", () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    chmodSync(path.dirname(file), 0o755);
    ledgerAt().claim(A);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("fails closed: a job whose start cannot be written down is not started, and is not remembered either", () => {
    const ledger = ledgerAt();
    chmodSync(path.dirname(file), 0o500);
    expect(ledger.claim(A)).toBe(false);
    chmodSync(path.dirname(file), 0o700);
    expect(ledger.claim(A)).toBe(true);
  });
});

describe("how the file is written", () => {
  it("leaves no temporary file behind when the rename fails, and does not remember the id", () => {
    const ledger = ledgerAt();
    // A directory where the ledger file should be: writing the temporary file works, renaming it over a directory does not.
    mkdirSync(file);
    expect(ledger.claim(A)).toBe(false);
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    rmSync(file, { recursive: true });
    expect(ledger.claim(A)).toBe(true);
  });

  // That the temporary file is opened exclusively and flushed before the rename is in ledgerWrite.test.ts, which pins the random name
  // and records the file calls.
});

describe("how long an id is kept", () => {
  it("keeps each id until its own expires_at, and forgets it after", () => {
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const ledger = ledgerAt(file, () => new Date(now));
    // A is a 72 hour job, B a 1 hour one.
    expect(ledger.claim(A, "2026-10-04T00:00:00.000Z")).toBe(true);
    expect(ledger.claim(B, "2026-10-01T01:00:00.000Z")).toBe(true);
    now = Date.parse("2026-10-01T00:59:59.000Z");
    ledger.claim(C, "2026-10-04T00:00:00.000Z");
    expect(idsInFile()).toEqual([A, B, C]);
    now = Date.parse("2026-10-01T01:00:01.000Z");
    ledger.claim("44444444-4444-4444-8444-444444444444", "2026-10-04T00:00:00.000Z");
    expect(idsInFile()).not.toContain(B);
    expect(idsInFile()).toContain(A);
    // Still inside its life, so still refused, even though that is more than the old flat 96 hours of the other ids.
    now = Date.parse("2026-10-03T23:00:00.000Z");
    expect(ledger.claim(A)).toBe(false);
  });

  it("keeps an id longer than four days when its job lives longer", () => {
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const ledger = ledgerAt(file, () => new Date(now));
    ledger.claim(A, "2026-10-20T00:00:00.000Z");
    now = Date.parse("2026-10-15T00:00:00.000Z");
    ledger.claim(B, "2026-10-20T00:00:00.000Z");
    expect(idsInFile()).toContain(A);
  });

  it("keeps an id for four days when it is given no expiry (or one that is not a time)", () => {
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const ledger = ledgerAt(file, () => new Date(now));
    ledger.claim(A);
    ledger.claim(B, "tomorrow");
    now += 95 * 60 * 60_000;
    ledger.claim(C);
    expect(idsInFile()).toEqual([A, B, C]);
    now += 2 * 60 * 60_000;
    ledger.claim("44444444-4444-4444-8444-444444444444");
    expect(idsInFile()).not.toContain(A);
    expect(idsInFile()).not.toContain(B);
  });
});

describe("a ledger file that is not good (only a missing file is an empty ledger)", () => {
  const damage: Array<[string, string]> = [
    ["text that is not JSON", "not json"],
    ["an empty file (truncated)", ""],
    ["half a file", `{"${A}": 17`],
    ["an array", "[]"],
    ["null", "null"],
    ["an entry whose time is not a number", JSON.stringify({ [A]: "yesterday" })],
    ["an entry whose key is not a job id", JSON.stringify({ nope: 1 })],
    ["one good entry and one odd one", JSON.stringify({ [B]: Date.now() + 1e9, nope: 1 })],
  ];
  for (const [name, content] of damage) {
    it(`${name}: moved aside, and no job is started`, () => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      const ledger = ledgerAt();
      expect(ledger.closed).toBe(true);
      expect(ledger.claim(A)).toBe(false);
      expect(ledger.claim(B)).toBe(false);
      expect(existsSync(file)).toBe(false);
      const aside = asideOf();
      expect(aside).toHaveLength(1);
      expect(readFileSync(path.join(path.dirname(file), aside[0]!), "utf8")).toBe(content);
    });
  }

  it("a file that cannot be read is damaged too: moved aside and closed", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ [A]: Date.now() + 1e9 }));
    chmodSync(file, 0o000);
    // Running as a user that can read anything (root) cannot show this case; the file then reads fine and is a good ledger.
    const readable = (() => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    })();
    const ledger = ledgerAt();
    if (readable) expect(ledger.claim(A)).toBe(false);
    else {
      expect(ledger.closed).toBe(true);
      expect(ledger.claim(B)).toBe(false);
      expect(asideOf()).toHaveLength(1);
    }
  });

  it("stays closed after a restart until the ledger is recreated: a missing file next to a moved-aside one is not an empty ledger", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "garbage");
    const first = ledgerAt();
    expect(first.claim(A)).toBe(false);
    first.close();
    const restarted = ledgerAt();
    expect(restarted.closed).toBe(true);
    expect(restarted.claim(A)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("opens again when a valid ledger file is put back, without a restart, and then keeps what it holds", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "garbage");
    const ledger = ledgerAt();
    expect(ledger.claim(A)).toBe(false);
    writeFileSync(file, JSON.stringify({ [B]: Date.now() + 1e9 }), { mode: 0o600 });
    expect(ledger.claim(B)).toBe(false);
    expect(ledger.closed).toBe(false);
    expect(ledger.claim(A)).toBe(true);
    expect(idsInFile()).toEqual([A, B]);
  });

  it("a recreated file that is itself damaged is moved aside in its turn, and the ledger stays closed", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "garbage");
    const ledger = ledgerAt();
    writeFileSync(file, "more garbage");
    expect(ledger.claim(A)).toBe(false);
    expect(ledger.closed).toBe(true);
    expect(asideOf()).toHaveLength(2);
  });

  it("a directory that cannot be listed cannot be shown to hold no moved-aside ledger, so the ledger stays closed", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "garbage");
    const ledger = ledgerAt();
    expect(ledger.claim(A)).toBe(false);
    // Searchable and writable but not listable. (A user that can list anything, such as root, cannot show this case.)
    chmodSync(path.dirname(file), 0o300);
    let listable = true;
    try {
      readdirSync(path.dirname(file));
    } catch {
      listable = false;
    }
    if (!listable) expect(ledger.claim(A)).toBe(false);
    chmodSync(path.dirname(file), 0o700);
  });

  it("a missing file with nothing moved aside is an empty ledger", () => {
    const ledger = ledgerAt();
    expect(ledger.closed).toBe(false);
    expect(ledger.claim(A)).toBe(true);
  });

  it("a valid file keeps its entries (the control for the table above)", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ [A]: Date.now() + 1e9 }));
    const ledger = ledgerAt();
    expect(ledger.closed).toBe(false);
    expect(ledger.claim(A)).toBe(false);
    expect(ledger.claim(B)).toBe(true);
  });
});

describe("one process at a time", () => {
  it("a second ledger on the same file refuses to start, and does not touch the first's file", () => {
    const first = ledgerAt();
    first.claim(A);
    expect(() => createFileLedger(file, ledgerOptions())).toThrow(LedgerLockedError);
    expect(idsInFile()).toEqual([A]);
    expect(first.claim(B)).toBe(true);
  });

  it("the lock is released by close, and a new ledger then starts", () => {
    const first = ledgerAt();
    first.close();
    expect(first.claim(A)).toBe(false);
    expect(() => ledgerAt()).not.toThrow();
  });

  it("another live process's lock refuses; a lock left by a process that is gone is taken over", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    // The parent of this test process is alive for as long as the test runs.
    writeFileSync(`${file}.lock`, `${process.ppid}\n`);
    expect(() => createFileLedger(file, ledgerOptions())).toThrow(LedgerLockedError);
    // A pid that existed a moment ago and does not now.
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(`${file}.lock`, `${gone.stdout}\n`);
    const ledger = ledgerAt();
    expect(ledger.claim(A)).toBe(true);
    expect(readFileSync(`${file}.lock`, "utf8").trim()).toBe(String(process.pid));
  });

  it("a lock file that holds no pid is held within the grace, and taken over once it is older than that", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, "");
    // Fresh: another starter may still be filling it in, so it counts as held.
    expect(() => createFileLedger(file, ledgerOptions())).toThrow(LedgerLockedError);
    expect(existsSync(`${file}.lock`)).toBe(true);
    // The same for an unreadable owner (not a number).
    writeFileSync(`${file}.lock`, "not a pid\n");
    expect(() => createFileLedger(file, ledgerOptions())).toThrow(LedgerLockedError);
    // Old: a crash left it. Taken over, and the lock then holds this process's pid.
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(ledgerAt().claim(A)).toBe(true);
    expect(readFileSync(`${file}.lock`, "utf8").trim()).toBe(String(process.pid));
  });

  it("an empty lock is held only for the grace, measured by the injected clock against the file's mtime", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, "");
    const mtime = statSync(`${file}.lock`).mtimeMs;
    expect(() => createFileLedger(file, ledgerOptions(() => new Date(mtime + 4_000)))).toThrow(LedgerLockedError);
    expect(ledgerAt(file, () => new Date(mtime + 6_000)).claim(A)).toBe(true);
  });

  it("the lock is published with its pid in it and leaves no temporary file", () => {
    ledgerAt();
    expect(readFileSync(`${file}.lock`, "utf8")).toBe(`${process.pid}\n`);
    expect(statSync(`${file}.lock`).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(["jobs.json.lock"]);
  });

  it("two takeovers of one stale lock: exactly one wins, and the lock holds the winner's pid", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const STALE = 4_000_001;
    const WINNER = 4_000_002;
    const LOSER = 4_000_003;
    writeFileSync(`${file}.lock`, `${STALE}\n`);
    const gone = (pid: number): boolean => pid !== STALE;
    let winner: FileLedger | undefined;
    // The loser has read the stale pid and is asking whether it is alive; before it answers, the other process runs its whole takeover.
    const loserAlive = (pid: number): boolean => {
      winner = createFileLedger(file, { pid: WINNER, isAlive: gone });
      open.push(winner);
      return gone(pid);
    };
    expect(() => createFileLedger(file, { pid: LOSER, isAlive: loserAlive })).toThrow(LedgerLockedError);
    expect(winner).toBeDefined();
    expect(readFileSync(`${file}.lock`, "utf8").trim()).toBe(String(WINNER));
    expect(winner?.claim(A)).toBe(true);
    // Nothing is left beside the lock and the ledger: no aside copy, no temporary file.
    expect(readdirSync(path.dirname(file)).sort()).toEqual(["jobs.json", "jobs.json.lock"]);
  });

  it("two takeovers the other way round: the second one to move the lock finds it replaced and puts it back", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const STALE = 4_000_001;
    writeFileSync(`${file}.lock`, `${STALE}\n`);
    const first = createFileLedger(file, { pid: 4_000_002, isAlive: (pid) => pid !== STALE });
    open.push(first);
    // The second process judged the lock stale before the first one replaced it; its rename now catches the first one's lock.
    writeFileSync(`${file}.lock`, `${STALE}\n`);
    let calls = 0;
    const isAlive = (pid: number): boolean => {
      calls++;
      if (calls === 1) writeFileSync(`${file}.lock`, "4000002\n");
      return pid !== STALE;
    };
    expect(() => createFileLedger(file, { pid: 4_000_003, isAlive })).toThrow(LedgerLockedError);
    expect(readFileSync(`${file}.lock`, "utf8").trim()).toBe("4000002");
    expect(readdirSync(path.dirname(file)).sort()).toEqual(["jobs.json.lock"]);
  });

  it("closing a ledger whose lock was taken over leaves the new holder's lock", () => {
    const lost = createFileLedger(file, { pid: 4_000_011, isAlive: pidIsAlive });
    // Its lock is taken away (the process looked dead to another starter) and the new holder publishes its own.
    unlinkSync(`${file}.lock`);
    const holder = createFileLedger(file, { pid: process.pid, isAlive: pidIsAlive });
    open.push(holder);
    lost.close();
    expect(readFileSync(`${file}.lock`, "utf8").trim()).toBe(String(process.pid));
    expect(() => createFileLedger(file, ledgerOptions())).toThrow(LedgerLockedError);
    // The holder's own close still removes it.
    holder.close();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
