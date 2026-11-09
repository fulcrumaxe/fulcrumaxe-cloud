import { afterEach, describe, expect, it } from "vitest";
import { acceptRecords } from "../src/recordParser.js";
import { nodeCmd, recorderDir, runRecorder } from "./helpers/recorderHarness.js";

/**
 * D#2 RLR-3a: every single loss of bytes (one dropped run) and every single doubled run, at every position and length, over files
 * the real recorder wrote. The parser may return fewer records or a shorter prefix; it may never return a record, or a trailer,
 * that differs from the one written. This is the guarantee the parser header claims. It does not cover several separate losses.
 */
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const EXIT = 130;

/** The record file for a child that prints `bytes` exactly and exits with 130. */
async function fileFor(bytes: Buffer | "big"): Promise<Buffer> {
  const d = recorderDir();
  cleanup.push(d.done);
  // a one-megabyte line is made in the child, not passed in argv
  const data = bytes === "big" ? 'Buffer.concat([Buffer.alloc(1048577, 0x61), Buffer.from("\\n")])' : 'Buffer.from(process.argv[1], "hex")';
  const js = `process.stdout.write(${data}, () => process.exit(${EXIT}))`;
  const r = await runRecorder(d, nodeCmd(js, bytes === "big" ? "" : bytes.toString("hex")));
  expect(r.code).toBe(EXIT);
  return r.file;
}

const cases: [string, Buffer | "big"][] = [
  ["a tab", Buffer.from("a\tb\n")],
  ["e-acute", Buffer.from("xéy\n")],
  ["the euro sign", Buffer.from("€\n")],
  ["a NUL byte", Buffer.from("1\u0000\n")],
  ["bytes that are not UTF-8 (b64)", Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a, 0xc3, 0x28, 0x0a])],
  ["a line over the cap (big)", "big"],
  ["an unterminated last line (tail)", Buffer.from("abc\nlast without newline")],
  ["several plain lines and a JSON line with a tab", Buffer.from('abcdefghij\n{"type":"result","usage":{"output_tokens":5\t}}\n')],
];

describe("one dropped or doubled run of bytes never yields a wrong record", () => {
  for (const [name, bytes] of cases) {
    it(`exhaustive over ${name}`, async () => {
      const file = await fileFor(bytes);
      const truth = acceptRecords(file, 0);
      expect(truth.stop).toBeNull();
      expect(truth.trailer?.code).toBe(EXIT);
      expect(truth.run).toBe("run-x");
      let trials = 0;
      const wrong: string[] = [];
      const check = (buf: Buffer, label: string): void => {
        trials++;
        const got = acceptRecords(buf, 0);
        if (got.run !== null && got.run !== truth.run) wrong.push(`${label}: run ${got.run}`);
        if (got.trailer && JSON.stringify(got.trailer) !== JSON.stringify(truth.trailer)) wrong.push(`${label}: trailer ${JSON.stringify(got.trailer)}`);
        got.records.forEach((r, i) => {
          const t = truth.records[i];
          if (!t || r.seq !== t.seq || r.kind !== t.kind || r.n !== t.n || r.size !== t.size || !r.data.equals(t.data)) wrong.push(`${label}: record ${i} ${JSON.stringify(r.data.toString("latin1"))}`);
        });
      };
      for (let a = 0; a < file.length; a++) {
        for (let b = a + 1; b <= file.length; b++) {
          check(Buffer.concat([file.subarray(0, a), file.subarray(b)]), `drop [${a},${b})`);
          check(Buffer.concat([file.subarray(0, b), file.subarray(a, b), file.subarray(b)]), `dup [${a},${b})`);
        }
      }
      expect(trials).toBeGreaterThan(1000);
      expect(wrong.slice(0, 3)).toEqual([]);
    });
  }
});
