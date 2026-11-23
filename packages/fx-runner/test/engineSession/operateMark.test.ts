import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATE_MARK_DIR, OPERATE_MARK_FILE, createOperateMark, type OperateMarkEvent } from "../../src/engineSession/operateMark.js";
import { tempDir } from "../helpers/tempTree.js";

/** D#845 ON-13a1 item 3: the persisted operate high-water mark. */
const UID = process.getuid!();
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const OTHER = "11111111-1111-4111-8111-111111111111";
function mark() {
  const stateDir = tempDir("fx-opmark-");
  const events: OperateMarkEvent[] = [];
  const make = () => createOperateMark({ stateDir, uid: UID, log: (e) => events.push(e) });
  const dir = path.join(stateDir, OPERATE_MARK_DIR);
  return { stateDir, events, make, dir, file: path.join(dir, OPERATE_MARK_FILE) };
}

describe("the operate mark", () => {
  it("a missing mark is 0; each job raises it to the largest epoch seen and never lowers it", () => {
    const m = mark();
    const k = m.make();
    expect(k.observe(RUNNER, 3)).toEqual({ ok: true, prior: 0 });
    expect(k.observe(RUNNER, 5)).toEqual({ ok: true, prior: 3 });
    expect(k.observe(RUNNER, 2)).toEqual({ ok: true, prior: 5 }); // a lower epoch is answered, and does not lower the mark
    expect(k.observe(RUNNER, 5)).toEqual({ ok: true, prior: 5 });
    expect(JSON.parse(readFileSync(m.file, "utf8"))).toEqual({ runner_id: RUNNER, operate_epoch: 5 });
  });

  it("survives a daemon restart: a new mark over the same directory reads what the last one wrote", () => {
    const m = mark();
    m.make().observe(RUNNER, 9);
    expect(m.make().observe(RUNNER, 0)).toEqual({ ok: true, prior: 9 });
  });

  it("is a 0600 file in a 0700 directory", () => {
    const m = mark();
    m.make().observe(RUNNER, 1);
    expect(lstatSync(m.file).mode & 0o777).toBe(0o600);
    expect(lstatSync(m.dir).mode & 0o777).toBe(0o700);
  });

  it("a mark written for another runner id (a re-registered machine) reads as 0 and is replaced, without a reset event", () => {
    const m = mark();
    m.make().observe(OTHER, 8);
    expect(m.make().observe(RUNNER, 1)).toEqual({ ok: true, prior: 0 });
    expect(JSON.parse(readFileSync(m.file, "utf8"))).toEqual({ runner_id: RUNNER, operate_epoch: 1 });
    expect(m.events).toEqual([]);
  });

  it("the runner id compares without regard to case", () => {
    const m = mark();
    m.make().observe(RUNNER.toUpperCase(), 4);
    expect(m.make().observe(RUNNER, 0)).toEqual({ ok: true, prior: 4 });
  });

  it.each([["not json", "{nope"], ["an array", "[1]"], ["a missing key", JSON.stringify({ runner_id: RUNNER })], ["an extra key", JSON.stringify({ runner_id: RUNNER, operate_epoch: 4, x: 1 })], ["a negative epoch", JSON.stringify({ runner_id: RUNNER, operate_epoch: -1 })], ["a fraction", JSON.stringify({ runner_id: RUNNER, operate_epoch: 1.5 })], ["a string epoch", JSON.stringify({ runner_id: RUNNER, operate_epoch: "4" })]])("a malformed mark (%s) reads as 0 and logs one operate_mark_reset", (_name, text) => {
    const m = mark();
    mkdirSync(m.dir, { mode: 0o700 });
    writeFileSync(m.file, text, { mode: 0o600 });
    expect(m.make().observe(RUNNER, 2)).toEqual({ ok: true, prior: 0 });
    expect(m.events).toEqual([{ event: "operate_mark_reset" }]);
    expect(JSON.parse(readFileSync(m.file, "utf8"))).toEqual({ runner_id: RUNNER, operate_epoch: 2 });
  });

  it("a symlinked mark file is refused and nothing is written through it", () => {
    const m = mark();
    mkdirSync(m.dir, { mode: 0o700 });
    const elsewhere = path.join(tempDir("fx-opmark-target-"), "target.json");
    writeFileSync(elsewhere, "untouched\n");
    symlinkSync(elsewhere, m.file);
    expect(m.make().observe(RUNNER, 5)).toEqual({ ok: false });
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
    expect(lstatSync(m.file).isSymbolicLink()).toBe(true);
  });

  it("a mark that is a directory is refused too, and a state directory that is a link is refused with nothing written", () => {
    const m = mark();
    mkdirSync(m.file, { recursive: true, mode: 0o700 });
    expect(m.make().observe(RUNNER, 1)).toEqual({ ok: false });
    const n = mark();
    const target = tempDir("fx-opmark-dir-");
    symlinkSync(target, n.dir);
    expect(n.make().observe(RUNNER, 1)).toEqual({ ok: false });
    expect(existsSync(path.join(target, OPERATE_MARK_FILE))).toBe(false);
  });

  it("an epoch that is not a whole number at or above 0 is refused and writes nothing", () => {
    const m = mark();
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(m.make().observe(RUNNER, bad)).toEqual({ ok: false });
    expect(existsSync(m.file)).toBe(false);
  });
});
