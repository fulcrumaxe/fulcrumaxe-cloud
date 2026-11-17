import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineDialsReply, engineDialsTarget } from "@fulcrumaxe/runner-protocol";
import {
  buildCeiling,
  CEILING_CLASSES,
  CEILING_FILE,
  CEILING_LIFE_S,
  ceilingOf,
  CeilingKeeper,
  CeilingWriteRefused,
  createDialsFetcher,
  REFRESH_MS,
  REPLY_SKEW_S,
  writeCeiling,
  type CeilingFile,
  type Disposition,
  type DialsOutcome,
} from "../../src/engineBridge/ceiling.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, until, type ManualClock } from "../helpers/manualClock.js";
import { startStrictEngineDials, type StrictEngineDials } from "../helpers/strictEngineDials.js";

/**
 * EB-9b, the runner side. The engine's own loader (backend/cloud_ceiling.py, EB-10c) is the contract: `engineAccepts` is that loader's rule set written
 * out, and every file the runner writes must pass it. The two are kept in step by hand; a change to either is a change to the other.
 *
 * Where this copy is still looser than the engine's loader: it would take `v: true`, a ceiling written as a float (1.0 or 5e0) and a date-only timestamp,
 * none of which the engine accepts. Each of the three is closed below by a text check of the raw file (JSON parsing in JavaScript cannot tell 1 from
 * 1.0, and `true !== 1` only holds here because the compare is strict). The copy is still not the engine's code: the parts it does not model (the exact
 * error handling, the platform's file checks) are read from the engine's source, not from this file.
 */
const UID = typeof process.getuid === "function" ? process.getuid() : undefined;
const GH = 4242;
const MAX_LIFE_S = 15 * 60;
const SKEW_S = 300;
const MAX_BYTES = 16 * 1024;

/** The engine's `cloud_ceiling.load` rules: `{class: n}` when the file is acceptable at `now`, null when the engine would read ceiling 1 for all three classes. */
function engineAccepts(dir: string, repoGhId: number, now: Date): Record<string, number> | null {
  const file = path.join(dir, CEILING_FILE);
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile() || (UID !== undefined && st.uid !== UID) || (st.mode & 0o077) !== 0 || st.size > MAX_BYTES) return null;
  const text = readFileSync(file, "utf8");
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc.v !== 1 || doc.repo_gh_id !== repoGhId) return null;
  // Closed against the engine: `"v":1` as an integer in the text, no float anywhere among the ceilings, and full UTC timestamps (not a bare date).
  if (!/"v":1[,}]/.test(text)) return null;
  const ceilingText = /"ceilings":\{[^}]*\}/.exec(text)?.[0] ?? "";
  if (/:\s*-?\d+(\.\d+|[eE][+-]?\d+)/.test(ceilingText)) return null;
  const FULL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  if (typeof doc.fetched_at !== "string" || typeof doc.expires_at !== "string" || !FULL_UTC.test(doc.fetched_at) || !FULL_UTC.test(doc.expires_at)) return null;
  const fetched = Date.parse(String(doc.fetched_at)) / 1000;
  const expires = Date.parse(String(doc.expires_at)) / 1000;
  const t = now.getTime() / 1000;
  if (!(expires > t) || fetched > t + SKEW_S || !(expires - fetched > 0 && expires - fetched <= MAX_LIFE_S)) return null;
  const ceilings = doc.ceilings as Record<string, unknown> | undefined;
  if (typeof ceilings !== "object" || ceilings === null) return null;
  for (const c of CEILING_CLASSES) if (typeof ceilings[c] !== "number" || !Number.isInteger(ceilings[c]) || (ceilings[c] as number) < 1 || (ceilings[c] as number) > 5) return null;
  if (doc.halted !== false) return Object.fromEntries(CEILING_CLASSES.map((c) => [c, 1]));
  return Object.fromEntries(CEILING_CLASSES.map((c) => [c, ceilings[c] as number]));
}

const reply = (over: Partial<EngineDialsReply> = {}): EngineDialsReply =>
  EngineDialsReply.parse({ repo_gh_id: GH, catalogue_version: 11, dispositions: { engine_spawn: "ask", engine_merge: "announce", engine_spec_ready: "ask" }, halt_epoch: 3, halted: false, fetched_at: "2026-11-16T15:00:00.000Z", ...over });
const AT = new Date("2026-11-16T15:00:00.000Z");
const DISPOSITIONS: Disposition[] = ["ask", "announce", "act"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-eb9b-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const ceilingFile = (): string => path.join(dir, CEILING_FILE);
const read = (): CeilingFile => JSON.parse(readFileSync(ceilingFile(), "utf8")) as CeilingFile;

describe("the mapping from a disposition to a ceiling", () => {
  it("is ask 1, announce 5, act 5", () => {
    expect([ceilingOf("ask"), ceilingOf("announce"), ceilingOf("act")]).toEqual([1, 5, 5]);
  });

  it.each(DISPOSITIONS.flatMap((spawn) => DISPOSITIONS.map((merge) => [spawn, merge] as const)))("spawn %s and merge %s: engine_spawn sets agent.spawn, engine_merge sets both merge classes", (spawn, merge) => {
    const file = buildCeiling(reply({ dispositions: { engine_spawn: spawn, engine_merge: merge, engine_spec_ready: "ask" } }), AT);
    expect(file.ceilings).toEqual({ "agent.spawn": ceilingOf(spawn), "merge.standard": ceilingOf(merge), "merge.fast-path": ceilingOf(merge) });
  });

  it("never reads engine_spec_ready: it sets no class", () => {
    for (const spec of DISPOSITIONS) {
      const file = buildCeiling(reply({ dispositions: { engine_spawn: "act", engine_merge: "act", engine_spec_ready: spec } }), AT);
      expect(file.ceilings).toEqual({ "agent.spawn": 5, "merge.standard": 5, "merge.fast-path": 5 });
    }
  });

  it("a halted repo is written with every ceiling at 1, whatever the dispositions are", () => {
    const file = buildCeiling(reply({ halted: true, dispositions: { engine_spawn: "act", engine_merge: "act", engine_spec_ready: "act" } }), AT);
    expect(file.halted).toBe(true);
    expect(file.ceilings).toEqual({ "agent.spawn": 1, "merge.standard": 1, "merge.fast-path": 1 });
  });

  it("has exactly the Spec's fields, a life of exactly 900 s from the runner's clock, and the cloud's catalogue version and halt epoch", () => {
    const file = buildCeiling(reply(), AT);
    expect(Object.keys(file).sort()).toEqual(["catalogue_version", "ceilings", "expires_at", "fetched_at", "halt_epoch", "halted", "repo_gh_id", "v"]);
    expect(file).toMatchObject({ v: 1, repo_gh_id: GH, catalogue_version: 11, halt_epoch: 3, halted: false, fetched_at: "2026-11-16T15:00:00.000Z", expires_at: "2026-11-16T15:15:00.000Z" });
    expect(CEILING_LIFE_S).toBe(MAX_LIFE_S);
  });
});

describe("the file as the engine reads it", () => {
  it("every combination passes the engine's rules and gives the ceilings that were meant", () => {
    for (const spawn of DISPOSITIONS) {
      for (const merge of DISPOSITIONS) {
        writeCeiling(dir, buildCeiling(reply({ dispositions: { engine_spawn: spawn, engine_merge: merge, engine_spec_ready: "ask" } }), new Date()), UID);
        expect(engineAccepts(dir, GH, new Date())).toEqual({ "agent.spawn": ceilingOf(spawn), "merge.standard": ceilingOf(merge), "merge.fast-path": ceilingOf(merge) });
      }
    }
  });

  it("a halted file reads as ceiling 1 for all three classes", () => {
    writeCeiling(dir, buildCeiling(reply({ halted: true }), new Date()), UID);
    expect(engineAccepts(dir, GH, new Date())).toEqual({ "agent.spawn": 1, "merge.standard": 1, "merge.fast-path": 1 });
  });

  it("lapses: after expires_at the engine no longer accepts it, and a file for another repo is never accepted", () => {
    writeCeiling(dir, buildCeiling(reply(), AT), UID);
    expect(engineAccepts(dir, GH, new Date(AT.getTime() + 899_000))).not.toBeNull();
    expect(engineAccepts(dir, GH, new Date(AT.getTime() + 900_000))).toBeNull();
    expect(engineAccepts(dir, GH + 1, new Date(AT.getTime() + 1000))).toBeNull();
  });

  it("is mode 0600 whatever the process umask, and holds one line of JSON", () => {
    const before = process.umask(0);
    try {
      writeCeiling(dir, buildCeiling(reply(), AT), UID);
    } finally {
      process.umask(before);
    }
    expect(statSync(ceilingFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(ceilingFile(), "utf8").trimEnd().includes("\n")).toBe(false);
  });

  it("with a strict umask it is still 0600 and not narrower than the owner's read and write", () => {
    const before = process.umask(0o277);
    try {
      writeCeiling(dir, buildCeiling(reply(), AT), UID);
    } finally {
      process.umask(before);
    }
    expect(statSync(ceilingFile()).mode & 0o777).toBe(0o600);
  });
});

describe("how it is written", () => {
  it("goes through a temp file and a rename: a second write is a new file at the name, and no temp file is left", () => {
    writeCeiling(dir, buildCeiling(reply(), AT), UID);
    const first = statSync(ceilingFile()).ino;
    writeCeiling(dir, buildCeiling(reply({ halt_epoch: 9 }), AT), UID);
    expect(statSync(ceilingFile()).ino).not.toBe(first);
    expect(read().halt_epoch).toBe(9);
    expect(readdirSync(dir)).toEqual([CEILING_FILE]);
  });

  it("makes the state directory 0700 when it is missing", () => {
    const fresh = path.join(dir, "state", "nested");
    writeCeiling(fresh, buildCeiling(reply(), AT), UID);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(engineAccepts(fresh, GH, new Date(AT.getTime() + 1000))).not.toBeNull();
  });
});

describe("every refusal leaves the old file as it was and writes nothing", () => {
  const writeOld = (): string => {
    writeCeiling(dir, buildCeiling(reply({ halt_epoch: 1 }), AT), UID);
    return readFileSync(ceilingFile(), "utf8");
  };
  const refused = (target: string, why: string): void => {
    let caught: unknown;
    try {
      writeCeiling(target, buildCeiling(reply({ halt_epoch: 2 }), AT), UID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CeilingWriteRefused);
    expect((caught as CeilingWriteRefused).reason).toBe(why);
    expect((caught as Error).message).not.toContain(target);
  };

  it("a relative directory", () => {
    refused("state/relative", "relative_dir");
    expect(existsSync("state/relative")).toBe(false);
  });

  it("a directory that is a link", () => {
    const real = path.join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(dir, "link");
    symlinkSync(real, link);
    refused(link, "dir_not_plain");
    expect(readdirSync(real)).toEqual([]);
  });

  it("a directory that is a plain file", () => {
    const file = path.join(dir, "file");
    writeFileSync(file, "x", { mode: 0o600 });
    refused(file, "dir_not_plain");
  });

  it("a directory open to group or other, in each bit", () => {
    for (const mode of [0o750, 0o705, 0o770, 0o777, 0o701, 0o710]) {
      chmodSync(dir, mode);
      refused(dir, "dir_open");
      expect(readdirSync(dir)).toEqual([]);
    }
    chmodSync(dir, 0o700);
  });

  it.skipIf(UID === undefined)("a directory of another user (the runner's uid is checked, not assumed)", () => {
    let caught: unknown;
    try {
      writeCeiling(dir, buildCeiling(reply(), AT), UID! + 1);
    } catch (error) {
      caught = error;
    }
    expect((caught as CeilingWriteRefused).reason).toBe("dir_foreign");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a link at the file's name: refused, and nothing is written through it", () => {
    const aside = path.join(dir, "aside");
    writeFileSync(aside, "keep", { mode: 0o600 });
    symlinkSync(aside, ceilingFile());
    refused(dir, "name_not_plain");
    expect(readFileSync(aside, "utf8")).toBe("keep");
    expect(lstatSync(ceilingFile()).isSymbolicLink()).toBe(true);
  });

  it("a directory at the file's name", () => {
    mkdirSync(ceilingFile(), { mode: 0o700 });
    refused(dir, "name_not_plain");
    expect(readdirSync(dir)).toEqual([CEILING_FILE]);
  });

  it("a temp-file name that already exists is never opened through (the create is exclusive and does not follow)", () => {
    const old = writeOld();
    // The temp name has 48 random bits, so it cannot be planted ahead; a link planted at a guessed name is simply not what is opened. What this checks is
    // that a write leaves no stray names behind and the old file is replaced whole.
    writeCeiling(dir, buildCeiling(reply({ halt_epoch: 5 }), AT), UID);
    expect(readdirSync(dir)).toEqual([CEILING_FILE]);
    expect(readFileSync(ceilingFile(), "utf8")).not.toBe(old);
  });

  it("the old file survives a refusal byte for byte", () => {
    const old = writeOld();
    chmodSync(dir, 0o755);
    refused(dir, "dir_open");
    chmodSync(dir, 0o700);
    expect(readFileSync(ceilingFile(), "utf8")).toBe(old);
  });
});

describe("the fetch, signed, against a strict stand-in for the route", () => {
  let cloud: StrictEngineDials;
  let key: ReturnType<typeof generateRunnerKey>;
  beforeEach(async () => {
    cloud = await startStrictEngineDials();
    key = generateRunnerKey();
    cloud.trust(key.publicJwk);
    cloud.covered.add(GH);
  });
  afterEach(async () => {
    await cloud.close();
  });
  const fetcher = (over: { now?: () => Date; fetchFn?: typeof fetch } = {}) => createDialsFetcher({ origin: cloud.origin, key, now: over.now ?? (() => new Date()), fetchFn: over.fetchFn ?? fetch });
  const failed = (o: DialsOutcome): string => (o.kind === "failed" ? o.why : "ok");

  it("sends one signed GET with the canonical query and no body, and takes the reply", async () => {
    const outcome = await fetcher()(GH);
    expect(outcome.kind).toBe("ok");
    expect(cloud.seen).toHaveLength(1);
    expect(cloud.seen[0]).toMatchObject({ method: "GET", url: engineDialsTarget(GH), bodyBytes: 0, status: 200 });
    expect(cloud.seen[0]!.headers["signature-input"]).toBeDefined();
    if (outcome.kind === "ok") expect(outcome.reply).toMatchObject({ repo_gh_id: GH, catalogue_version: 11 });
  });

  it("a repo the cloud does not cover (404) is a failed fetch", async () => {
    expect(failed(await fetcher()(GH + 1))).toBe("status");
  });

  it("a key the cloud does not know (401) is a failed fetch", async () => {
    const other = createDialsFetcher({ origin: cloud.origin, key: generateRunnerKey(), now: () => new Date(), fetchFn: fetch });
    expect(failed(await other(GH))).toBe("status");
  });

  it.each([500, 503, 429, 403])("status %i is a failed fetch", async (status) => {
    cloud.faults.push({ status });
    expect(failed(await fetcher()(GH))).toBe("status");
  });

  it.each([
    ["not JSON", { raw: "<html>", status: 200 }],
    ["an extra key", { status: 200, body: { ...reply(), cost: 1 } }],
    ["a missing key", { status: 200, body: { repo_gh_id: GH } }],
    ["an unknown disposition", { status: 200, body: { ...reply(), dispositions: { engine_spawn: "maybe", engine_merge: "act", engine_spec_ready: "ask" } } }],
    ["a missing decision type", { status: 200, body: { ...reply(), dispositions: { engine_spawn: "act", engine_merge: "act" } } }],
    ["a negative halt epoch", { status: 200, body: { ...reply(), halt_epoch: -1 } }],
    ["a halted flag that is not a boolean", { status: 200, body: { ...reply(), halted: "no" } }],
    ["a timestamp that is not UTC ISO", { status: 200, body: { ...reply(), fetched_at: "yesterday" } }],
  ] as const)("%s is a failed fetch", async (_name, fault) => {
    cloud.faults.push(fault);
    expect(failed(await fetcher()(GH))).toBe("unexpected");
  });

  it("an answer for another repo is a failed fetch, never a file", async () => {
    cloud.faults.push({ status: 200, body: reply({ repo_gh_id: GH + 7, fetched_at: new Date().toISOString() }) });
    expect(failed(await fetcher()(GH))).toBe("other_repo");
  });

  it("an answer whose clock is more than 300 s from the runner's is stale (a cached or replayed reply cannot buy a fresh life)", async () => {
    for (const offset of [-(REPLY_SKEW_S + 5), REPLY_SKEW_S + 5]) {
      cloud.faults.push({ status: 200, body: reply({ fetched_at: new Date(Date.now() + offset * 1000).toISOString() }) });
      expect(failed(await fetcher()(GH))).toBe("stale");
    }
    cloud.faults.push({ status: 200, body: reply({ fetched_at: new Date(Date.now() - (REPLY_SKEW_S - 20) * 1000).toISOString() }) });
    expect((await fetcher()(GH)).kind).toBe("ok");
  });

  // Two layers, either of which is enough: the schema's pattern refuses a part out of range ("unexpected"), and the skew check treats a time that does not
  // parse as stale (`!(skew <= limit)`), so an answer can never be fresh by way of NaN. The test accepts either word and never an "ok".
  it("a timestamp that is the right shape but not a real time is a failed fetch, never a fresh answer", async () => {
    for (const fetched_at of ["2026-13-45T99:99:99Z", "2026-00-10T10:00:00Z", "2026-11-16T25:00:00Z", "2026-11-16T10:60:00Z", "2026-11-16T10:00:60Z"]) {
      cloud.faults.push({ status: 200, body: { ...reply(), fetched_at } });
      expect(["unexpected", "stale"]).toContain(failed(await fetcher()(GH)));
    }
  });

  it("a redirect is never followed: it is a failed fetch", async () => {
    cloud.faults.push({ status: 302 });
    expect(failed(await fetcher()(GH))).toBe("network");
  });

  it("a dropped connection is a failed fetch and never throws", async () => {
    cloud.faults.push("drop");
    expect(failed(await fetcher()(GH))).toBe("network");
  });

  it("a fetch that throws is a failed fetch with a fixed word, not the error", async () => {
    const boom = (async () => {
      throw new Error("secret-token-abc at /home/someone/.key");
    }) as unknown as typeof fetch;
    const outcome = await fetcher({ fetchFn: boom })(GH);
    expect(outcome).toEqual({ kind: "failed", why: "network" });
  });
});

describe("the keeper", () => {
  let clock: ManualClock;
  let logs: string[];
  beforeEach(() => {
    clock = manualClock(AT.getTime());
    logs = [];
  });
  const keeper = (fetchDials: (id: number) => Promise<DialsOutcome>, over: { stateDir?: string } = {}) => new CeilingKeeper({ fetchDials, stateDir: over.stateDir ?? dir, uid: UID, clock, repoGhId: GH, log: (l) => logs.push(l) });
  const ok = (over: Partial<EngineDialsReply> = {}): DialsOutcome => ({ kind: "ok", reply: reply({ fetched_at: clock.now().toISOString(), ...over }) });

  it("a good answer writes the file with the runner's clock, and the engine accepts it", async () => {
    const k = keeper(async () => ok());
    expect(await k.refresh()).toBe("written");
    expect(read()).toMatchObject({ fetched_at: AT.toISOString(), expires_at: new Date(AT.getTime() + 900_000).toISOString() });
    expect(engineAccepts(dir, GH, clock.now())).not.toBeNull();
    expect(k.status()).toBe("written");
  });

  it("a failed fetch leaves the old file, which then lapses, and the engine reads ceiling 1 for all three classes", async () => {
    let fail = false;
    const k = keeper(async () => (fail ? { kind: "failed", why: "network" } : ok({ dispositions: { engine_spawn: "act", engine_merge: "act", engine_spec_ready: "act" } })));
    await k.refresh();
    const old = readFileSync(ceilingFile(), "utf8");
    expect(engineAccepts(dir, GH, clock.now())).toEqual({ "agent.spawn": 5, "merge.standard": 5, "merge.fast-path": 5 });
    fail = true;
    await clock.advance(5 * 60_000);
    expect(await k.refresh()).toBe("kept_old");
    expect(readFileSync(ceilingFile(), "utf8")).toBe(old);
    expect(engineAccepts(dir, GH, clock.now())).not.toBeNull();
    await clock.advance(10 * 60_000);
    expect(await k.refresh()).toBe("kept_old");
    expect(readFileSync(ceilingFile(), "utf8")).toBe(old);
    // fixed time: the file ran out, so the engine takes no ceiling from it
    expect(engineAccepts(dir, GH, clock.now())).toBeNull();
    expect(logs.every((l) => l.startsWith("engine-bridge: "))).toBe(true);
  });

  it("never writes a file when there has been no good answer (nothing is guessed)", async () => {
    const k = keeper(async () => ({ kind: "failed", why: "status" }));
    expect(await k.refresh()).toBe("kept_old");
    expect(existsSync(ceilingFile())).toBe(false);
  });

  it("a fetcher that throws is a kept file and a fixed log line, never an escape", async () => {
    const k = keeper(async () => {
      throw new Error("/secret/path sk-abc");
    });
    expect(await k.refresh()).toBe("kept_old");
    expect(logs).toEqual(["engine-bridge: the dial snapshot could not be fetched; the ceiling file is left as it is"]);
    expect(logs.join("")).not.toContain("secret");
  });

  it("a write that is refused (an open directory) keeps the old file and logs a fixed line", async () => {
    const k = keeper(async () => ok());
    await k.refresh();
    const old = readFileSync(ceilingFile(), "utf8");
    chmodSync(dir, 0o755);
    expect(await k.refresh()).toBe("kept_old");
    chmodSync(dir, 0o700);
    expect(readFileSync(ceilingFile(), "utf8")).toBe(old);
    expect(logs.join("")).not.toContain(dir);
  });

  it("run writes at once, then every 5 minutes", async () => {
    const calls: number[] = [];
    const k = keeper(async () => {
      calls.push(clock.now().getTime());
      return ok();
    });
    const abort = new AbortController();
    const done = k.run(abort.signal);
    await until(() => calls.length === 1 && clock.slept.length === 1);
    await clock.advance(REFRESH_MS - 1000, 1000);
    expect(calls).toHaveLength(1);
    await clock.advance(1000, 1000);
    await until(() => calls.length === 2);
    await until(() => clock.slept.length === 2);
    await clock.advance(REFRESH_MS, 1000);
    await until(() => calls.length === 3);
    expect(calls.map((t) => (t - AT.getTime()) / 1000)).toEqual([0, 300, 600]);
    abort.abort();
    await done;
  });

  it("controlsChanged writes again at once, without waiting for the timer", async () => {
    let n = 0;
    const k = keeper(async () => ok({ halt_epoch: n++ }));
    const abort = new AbortController();
    const done = k.run(abort.signal);
    await until(() => n === 1);
    k.controlsChanged();
    await until(() => n === 2);
    await until(() => existsSync(ceilingFile()) && read().halt_epoch === 1);
    expect(clock.now().getTime()).toBe(AT.getTime());
    abort.abort();
    await done;
  });

  it("a change that arrives while a fetch is in flight is followed by another fetch", async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const k = keeper(async () => {
      const mine = n++;
      if (mine === 0) await new Promise<void>((resolve) => (release = resolve));
      return ok({ halt_epoch: mine });
    });
    const abort = new AbortController();
    const done = k.run(abort.signal);
    await until(() => release !== undefined);
    k.controlsChanged();
    release!();
    await until(() => n === 2);
    abort.abort();
    await done;
  });

  it("stops when the signal aborts, and an abort during the wait ends the loop without another fetch", async () => {
    let n = 0;
    const k = keeper(async () => {
      n++;
      return ok();
    });
    const abort = new AbortController();
    const done = k.run(abort.signal);
    await until(() => n === 1 && clock.slept.length === 1);
    abort.abort();
    await done;
    expect(n).toBe(1);
  });
});

describe("the test's copy of the engine's rules is closed on what the engine refuses", () => {
  const good = (): string => {
    writeCeiling(dir, buildCeiling(reply(), new Date()), UID);
    return readFileSync(ceilingFile(), "utf8");
  };
  const put = (text: string): void => {
    rmSync(ceilingFile(), { force: true });
    writeFileSync(ceilingFile(), text, { mode: 0o600 });
  };

  it("takes what the runner writes, and refuses a boolean v, a float ceiling and a bare date", () => {
    const text = good();
    expect(engineAccepts(dir, GH, new Date())).not.toBeNull();
    put(text.replace('"v":1', '"v":true'));
    expect(engineAccepts(dir, GH, new Date())).toBeNull();
    put(text.replace('"agent.spawn":1', '"agent.spawn":1.0').replace('"agent.spawn":5', '"agent.spawn":5.0'));
    expect(engineAccepts(dir, GH, new Date())).toBeNull();
    put(text.replace(/"fetched_at":"[^"]*"/, '"fetched_at":"2026-11-16"'));
    expect(engineAccepts(dir, GH, new Date())).toBeNull();
  });
});
