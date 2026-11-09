import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, tmpdir } from "node:os";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HEAD_VIOLATION_LIMIT, RECORD_READ_CAP, acceptRecords, evaluateRead, isTampered, nextHeadStreak, readArgv, trailerExitCode, trailerMatchesWait,
} from "../src/recordParser.js";
import { nodeCmd, recorderDir, runRecorder } from "./helpers/recorderHarness.js";

/** D#2 RLR-3a: the B2 acceptance rule, the read contract and the hostile cases, over files the real recorder wrote. */
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

/** A record line as the recorder writes it, built here independently: the JSON text without its closing brace, then `,"c":"<first 16 hex of sha256>"}`. */
const seal = (p: string): string => p + ',"c":"' + createHash("sha256").update(p, "latin1").digest("hex").slice(0, 16) + '"}\n';
const line = (o: { s: number; t?: number; [k: string]: unknown }): string => seal(JSON.stringify({ ...o, t: o.t ?? o.s }).slice(0, -1));
const HDR = line({ s: 0, k: "h", run: "r", v: 1 });
const out = (data: Buffer | string, size: number): Buffer => Buffer.concat([Buffer.from(data), Buffer.from([0xff]), Buffer.from(`@${size}`)]);
/** What the read script prints for a file image: bytes from `offset`, at most `cap`, then the size. */
const readOf = (file: Buffer, offset: number, cap = RECORD_READ_CAP): Buffer => out(file.subarray(offset, offset + cap), file.length);

/** A real recorder file: 150 lines of mixed size and content, ending with its trailer. */
async function realFile(): Promise<Buffer> {
  const d = recorderDir();
  cleanup.push(d.done);
  const js = `for (let i=1;i<=150;i++) { const pad = i%25===0 ? "p".repeat(20000) : i%7===0 ? "\\u00e9\\u{1F600}".repeat(40) : "";
    process.stdout.write(JSON.stringify({i, pad})+"\\n"); }`;
  return (await runRecorder(d, nodeCmd(js))).file;
}

describe("acceptRecords: the B2 rule", () => {
  const o = (s: number, d: string, extra: object = {}): string => line({ s, k: "o", n: Buffer.byteLength(d), d, ...extra });
  const x = (s: number, extra: object = {}): string => line({ s, k: "x", code: 0, sig: null, lines: s - 1, bytes: 0, ...extra });

  it("accepts a contiguous run, stops clean at a partial last line", () => {
    const a = acceptRecords(Buffer.from(HDR + o(1, "a") + o(2, "b") + '{"s":3,"k":"o","n'), 0);
    expect([a.records.map((r) => r.seq), a.stop, a.bytes]).toEqual([[0, 1, 2], null, (HDR + o(1, "a") + o(2, "b")).length]);
  });

  it.each<[string, string, string]>([
    ["invalid JSON with a good check value", HDR + seal("{nope"), "bad_json"],
    ["a non-object with a good check value", HDR + seal("[1"), "bad_json"],
    ["a line with no check value", HDR + '{"s":1,"k":"o","n":1,"d":"a","t":1}\n', "bad_check"],
    ["a line whose check value is wrong", HDR + o(1, "a").replace(/"c":"[0-9a-f]/, '"c":"0'), "bad_check"],
    ["a line changed after its check value was made", HDR + o(1, "a").replace('"d":"a"', '"d":"b"'), "bad_check"],
    ["an unknown kind", HDR + line({ s: 1, k: "z" }), "bad_kind"],
    ["a seq gap", HDR + o(2, "a"), "bad_seq"],
    ["a closing seq that differs", HDR + line({ s: 1, k: "o", n: 1, d: "a", t: 9 }), "bad_record"],
    ["a record spliced from the head of one and the tail of another", HDR + seal('{"s":1,"k":"o","n":3,"d":"abc","t":2'), "bad_record"],
    ["a repeated seq", HDR + o(1, "a") + o(1, "a"), "bad_seq"],
    ["a length that does not match", HDR + line({ s: 1, k: "o", n: 9, d: "abc" }), "length_mismatch"],
    ["a non-ASCII byte", HDR + o(1, "café"), "non_ascii"],
    ["a data field that is not a string", HDR + line({ s: 1, k: "o", n: 1, d: 5 }), "bad_record"],
    ["an unknown encoding", HDR + o(1, "a", { e: "hex" }), "bad_record"],
    ["a big record with data", HDR + line({ s: 1, k: "big", n: 5, d: "x" }), "bad_record"],
    ["a header that is not first", line({ s: 0, k: "o", n: 0, d: "" }), "header_misplaced"],
    ["a second header", HDR + line({ s: 1, k: "h", run: "r", v: 1 }), "header_misplaced"],
    ["a trailer whose lines do not match", HDR + x(1, { lines: 5 }), "bad_trailer"],
    ["a trailer with a bad signal name", HDR + x(1, { code: null, sig: "term" }), "bad_trailer"],
    ["a record after the trailer", HDR + x(1) + o(2, "a"), "after_trailer"],
  ])("stops at %s", (_n, text, reason) => {
    const a = acceptRecords(Buffer.from(text), 0);
    expect(a.stop).toBe(reason);
    expect(a.records.length).toBeLessThanOrEqual(2);
  });

  it("decodes b64 data byte for byte and checks n against the raw length", () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00]);
    const ok = acceptRecords(Buffer.from(HDR + line({ s: 1, k: "o", n: 3, e: "b64", d: raw.toString("base64") })), 0);
    expect(ok.records[1]!.data.equals(raw)).toBe(true);
    const bad = acceptRecords(Buffer.from(HDR + line({ s: 1, k: "o", n: 4, e: "b64", d: raw.toString("base64") })), 0);
    expect(bad.stop).toBe("length_mismatch");
  });

  it("returns the header's run id so the caller can compare it with the run it expects, and null when the header is not in the read", () => {
    expect(acceptRecords(Buffer.from(HDR + o(1, "a")), 0).run).toBe("r");
    expect(acceptRecords(Buffer.from(o(5, "a")), 5).run).toBeNull();
    expect(acceptRecords(Buffer.from(HDR.replace('"run":"r"', '"run":"s"')), 0).stop).toBe("bad_check");
  });

  it("starts at the seq it is given, so a read after the header continues the run", () => {
    expect(acceptRecords(Buffer.from(o(5, "a")), 5).records.length).toBe(1);
    expect(acceptRecords(Buffer.from(o(5, "a")), 4).stop).toBe("bad_seq");
  });
});

describe("lossy, cut and duplicated reads never yield a wrong record", () => {
  it("over a real recorder file: every accepted record is the one that was written at that position", async () => {
    const file = await realFile();
    const truth = acceptRecords(file, 0);
    expect(truth.stop).toBeNull();
    expect(truth.records.length).toBe(152);
    const nl: number[] = [];
    for (let i = 0; i < file.length; i++) if (file[i] === 0x0a) nl.push(i + 1);
    let seed = 12345;
    const rnd = (n: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const pick = (aligned: boolean): number => (aligned ? nl[rnd(nl.length)]! : rnd(file.length));
    let fewer = 0;
    for (let trial = 0; trial < 900; trial++) {
      const aligned = trial % 2 === 0;
      let a = pick(aligned), b = pick(aligned);
      if (a > b) [a, b] = [b, a];
      const mode = trial % 3;
      const buf = mode === 0 ? Buffer.concat([file.subarray(0, a), file.subarray(b)]) //  drop a middle chunk
        : mode === 1 ? file.subarray(0, a) //                                        cut at a byte
        : Buffer.concat([file.subarray(0, b), file.subarray(a, b), file.subarray(b)]); // duplicate a chunk
      const got = acceptRecords(buf, 0);
      if (got.records.length < truth.records.length) fewer++;
      got.records.forEach((r, i) => {
        const t = truth.records[i]!;
        expect([r.seq, r.kind, r.n, r.size, r.data.equals(t.data)]).toEqual([t.seq, t.kind, t.n, t.size, true]);
      });
    }
    expect(fewer).toBeGreaterThan(600);
  });

  it("a flipped byte inside a payload is rejected; a forger who recomputes the check value is accepted: it is not a MAC (the exit cross-check catches that)", () => {
    const text = HDR + line({ s: 1, k: "o", n: 3, d: "abc" });
    expect(acceptRecords(Buffer.from(text.replace('"abc"', '"abd"')), 0).records.length).toBe(1);
    expect(acceptRecords(Buffer.from(HDR + line({ s: 1, k: "o", n: 3, d: "abd" })), 0).records[1]!.data.toString()).toBe("abd");
  });
});

describe("the read script and evaluateRead", () => {
  const sh = (rec: string, offset: number, cap: number): Buffer => execFileSync("sh", readArgv(offset, rec, cap), { stdio: ["ignore", "pipe", "ignore"] });

  it("runs under a real sh: bytes from the offset, cut at the cap, with the size taken after", async () => {
    const file = await realFile();
    const dir = mkdtempSync(join(tmpdir(), "rlr3a-read-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const rec = join(dir, "x.rec");
    writeFileSync(rec, file);
    expect(sh(rec, 0, RECORD_READ_CAP).equals(readOf(file, 0))).toBe(true);
    expect(sh(rec, 100, 500).equals(readOf(file, 100, 500))).toBe(true);
    expect(sh(rec, file.length, 500).equals(out("", file.length))).toBe(true);
    // a cap that cuts a record leaves a partial line, which is not a violation
    const cut = evaluateRead(sh(rec, 0, 300), { offset: 0, nextSeq: 0 });
    expect([cut.fault, cut.stop, cut.headViolation, cut.records.length > 0]).toEqual([null, null, false, true]);
  });

  it("reports a missing file as a failed read, which tail | head alone would call an idle agent", () => {
    const o = execFileSync("sh", readArgv(0, "/nonexistent/fx-run.rec", 100), { stdio: ["ignore", "pipe", "ignore"] });
    expect(evaluateRead(o, { offset: 0, nextSeq: 0 }).fault).toBe("read_failed");
    expect(evaluateRead(Buffer.alloc(0), { offset: 0, nextSeq: 0 }).fault).toBe("read_failed");
    expect(evaluateRead(Buffer.from("garbage@12"), { offset: 0, nextSeq: 0 }).fault).toBe("read_failed");
  });

  it("an idle agent is an empty clean read; a file longer than the offset that returns nothing is a failed read", () => {
    const idle = evaluateRead(out("", 10), { offset: 10, nextSeq: 3 });
    expect([idle.fault, idle.stop, idle.records.length]).toEqual([null, null, 0]);
    expect(evaluateRead(out("", 90), { offset: 10, nextSeq: 3 }).fault).toBe("read_failed");
  });

  it("hostile: a file truncated below the committed offset, or below what the read itself returned", async () => {
    const file = await realFile();
    expect(evaluateRead(readOf(file.subarray(0, 40), 0), { offset: 500, nextSeq: 1 }).fault).toBe("file_truncated");
    expect(evaluateRead(out(file.subarray(0, 200), 100), { offset: 0, nextSeq: 0 }).fault).toBe("file_truncated");
    expect(isTampered(0, evaluateRead(readOf(Buffer.alloc(0), 0), { offset: 500, nextSeq: 1 }))).toBe(true);
  });

  it("hostile: truncating and regrowing gives a violation at the head of the read", async () => {
    const file = await realFile();
    const offset = acceptRecords(file, 0).records.slice(0, 10).reduce((n, r) => n + r.size, 0);
    // after the rewrite the bytes at `offset` are the middle of some record
    const regrown = Buffer.concat([Buffer.alloc(offset), file.subarray(offset + 7)]);
    const o = evaluateRead(readOf(regrown, offset), { offset, nextSeq: 10 });
    expect([o.stop, o.headViolation]).toEqual(["bad_check", true]);
  });

  it("hostile: rewritten unread records with valid framing are accepted by the parser (only the exit cross-check sees them)", async () => {
    const file = await realFile();
    const edited = file.toString("latin1").replace('{\\"i\\":20,', '{\\"i\\":21,');
    expect(edited).not.toBe(file.toString("latin1"));
    expect(evaluateRead(readOf(Buffer.from(edited, "latin1"), 0), { offset: 0, nextSeq: 0 }).stop).toBe("bad_check"); // an edit that leaves the check value alone is caught
    // an edit by someone who also recomputes the check value of that line is not
    const forged = Buffer.from(edited.split("\n").map((l) => (l.includes('\\"i\\":21,') ? seal(l.slice(0, l.lastIndexOf(',"c":"'))).trimEnd() : l)).join("\n"), "latin1");
    expect(forged.equals(file)).toBe(false);
    expect(evaluateRead(readOf(forged, 0), { offset: 0, nextSeq: 0 }).stop).toBeNull();
  });

  it("hostile: a forged duplicate of the next record is a head violation on every later read until the streak says tampered", async () => {
    const file = await realFile();
    const all = acceptRecords(file, 0).records;
    const upto = (n: number): number => all.slice(0, n).reduce((s, r) => s + r.size, 0);
    // the forger appends a well-formed record with seq 5 while the reader has 5 records; the recorder's own seq-5 record follows
    const forgedRec = Buffer.from(line({ s: 5, k: "o", n: 1, d: "x" }));
    const img = Buffer.concat([file.subarray(0, upto(5)), forgedRec, file.subarray(upto(5), upto(8))]);
    const first = evaluateRead(readOf(img, 0), { offset: 0, nextSeq: 0 });
    expect(first.records.length).toBe(6); // the forgery itself is accepted (as powerful as forging stdout)
    const offset = first.bytes;
    let streak = 0;
    for (let i = 1; i <= HEAD_VIOLATION_LIMIT; i++) {
      const o = evaluateRead(readOf(img, offset), { offset, nextSeq: 6 });
      expect([o.stop, o.headViolation]).toEqual(["bad_seq", true]);
      streak = nextHeadStreak(streak, o);
      expect(isTampered(streak)).toBe(i >= HEAD_VIOLATION_LIMIT);
    }
  });

  it("hostile: a forged trailer is accepted mid-run, nothing may follow a trailer, and its code must equal wait()'s", async () => {
    const file = await realFile();
    const all = acceptRecords(file, 0);
    const mid = all.records.slice(0, 20).reduce((s, r) => s + r.size, 0);
    const forged = Buffer.concat([file.subarray(0, mid), Buffer.from(line({ s: 20, k: "x", code: 0, sig: null, lines: 19, bytes: 1 }))]);
    const a = acceptRecords(forged, 0);
    expect([a.stop, a.trailer?.code]).toEqual([null, 0]); // framing alone cannot tell: the caller must probe wait() (RLR-4)
    expect(trailerMatchesWait(a.trailer!, 0)).toBe(true);
    expect(trailerMatchesWait(a.trailer!, 1)).toBe(false);
    expect(acceptRecords(Buffer.concat([forged, file.subarray(mid)]), 0).stop).toBe("after_trailer");
    expect(trailerExitCode({ seq: 2, code: null, sig: "SIGTERM", lines: 1, bytes: 0 })).toBe(128 + constants.signals.SIGTERM);
  });

  it("surfaces a record larger than the read cap instead of stalling", () => {
    const cap = 1000;
    const big = out(Buffer.from('{"s":1,"k":"o","n":9999,"d":"' + "a".repeat(2000)).subarray(0, cap), 5000);
    const o = evaluateRead(big, { offset: 0, nextSeq: 1, cap });
    expect([o.fault, o.records.length]).toEqual(["record_exceeds_read_cap", 0]);
    // below the cap the same partial line is just a partial line
    expect(evaluateRead(out('{"s":1,"k":"o"', 5000), { offset: 0, nextSeq: 1, cap }).fault).toBeNull();
  });

  it("refuses a read that returned more than the cap: the agent can replace tail or head", () => {
    const cap = 100;
    const o = evaluateRead(out(HDR + HDR + HDR + HDR, 5000), { offset: 0, nextSeq: 0, cap });
    expect([o.fault, o.records.length]).toEqual(["read_exceeds_cap", 0]);
    expect(evaluateRead(out("a".repeat(cap), 5000), { offset: 0, nextSeq: 0, cap }).fault).toBe("record_exceeds_read_cap"); // exactly the cap is the other fault
    expect(evaluateRead(out(HDR, HDR.length), { offset: 0, nextSeq: 0, cap }).fault).toBeNull();
  });

  it("flags a record file past the size limit", () => {
    expect(evaluateRead(out("", 201 * 1024 * 1024), { offset: 201 * 1024 * 1024, nextSeq: 1 }).fault).toBe("log_oversize");
  });

  it("counts head violations: only consecutive ones, a fault holds the count, a good read resets it", () => {
    const bad = evaluateRead(out("zzz\n", 4), { offset: 0, nextSeq: 0 });
    const fault = evaluateRead(Buffer.alloc(0), { offset: 0, nextSeq: 0 });
    const ok = evaluateRead(out(HDR, HDR.length), { offset: 0, nextSeq: 0 });
    expect(bad.headViolation).toBe(true);
    expect(nextHeadStreak(2, bad)).toBe(3);
    expect(nextHeadStreak(2, fault)).toBe(2);
    expect(nextHeadStreak(2, ok)).toBe(0);
    expect(isTampered(2)).toBe(false);
    expect(isTampered(3)).toBe(true);
  });

  it("a violation after accepted records is not a head violation: those records are committed first", () => {
    const o = evaluateRead(out(HDR + "zzz\n", HDR.length + 4), { offset: 0, nextSeq: 0 });
    expect([o.records.length, o.stop, o.headViolation]).toEqual([1, "bad_check", false]);
  });
});

describe("a real file with bytes planted at its end", () => {
  it("makes the next read a head violation, never a wrong record", async () => {
    const d = recorderDir();
    cleanup.push(d.done);
    const r = await runRecorder(d, nodeCmd('process.stdout.write("a\\n")'));
    const offset = r.file.length;
    appendFileSync(d.rec, "garbage line\n");
    const o = evaluateRead(readOf(readFileSync(d.rec), offset), { offset, nextSeq: r.parsed.records.length });
    expect([o.records.length, o.headViolation]).toEqual([0, true]);
  });
});
