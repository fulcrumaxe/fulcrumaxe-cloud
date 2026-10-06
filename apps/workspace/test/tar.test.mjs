// apps/workspace/test/tar.test.mjs
//
// D#37 WS-A1 security fix round: unit tests for tar.mjs's readTar, built
// entirely from hand-crafted ustar buffers (no git archive needed for
// these -- they exercise malformed headers that a real git archive would
// never produce). Never reads or references the private source checkout.

import { describe, expect, it } from "vitest";
import { readTar, looksLikeTar } from "../import/tar.mjs";

const BLOCK_SIZE = 512;

/** Builds one 512-byte ustar header block. `size` may be a number (encoded
 * as octal, NUL-terminated) or a raw string (used byte-for-byte, e.g. to
 * construct a deliberately malformed field). */
function ustarHeader({ name, size, typeflag = "0", prefix = "" }) {
  const buf = Buffer.alloc(BLOCK_SIZE);
  buf.write(name.slice(0, 100), 0, "latin1");
  buf.write("0000644\0", 100, "latin1"); // mode
  buf.write("0000000\0", 108, "latin1"); // uid
  buf.write("0000000\0", 116, "latin1"); // gid
  const sizeField = typeof size === "string" ? size : size.toString(8).padStart(11, "0") + "\0";
  buf.write(sizeField.slice(0, 12), 124, "latin1");
  buf.write("00000000000\0", 136, "latin1"); // mtime
  buf.write("        ", 148, "latin1"); // chksum -- readTar never validates it
  buf.write(typeflag, 156, "latin1");
  buf.write("ustar\0", 257, "latin1");
  buf.write("00", 263, "latin1"); // version
  if (prefix) buf.write(prefix.slice(0, 155), 345, "latin1");
  return buf;
}

function padTo512(buf) {
  const rem = buf.length % BLOCK_SIZE;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - rem)]);
}

/** Builds a "<len> key=value\n" PAX record using the standard self-referential
 * length algorithm (the length digits are themselves part of what's counted). */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length;
  for (;;) {
    const total = len + String(len).length;
    if (String(total).length + body.length === total) {
      return `${total}${body}`;
    }
    len = total;
  }
}

function buildRawTar(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(ustarHeader(e));
    if (e.data !== undefined) parts.push(padTo512(Buffer.from(e.data)));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

function padToAtLeast(buf, minLength) {
  return buf.length >= minLength ? buf : Buffer.concat([buf, Buffer.alloc(minLength - buf.length)]);
}

const COMMIT_ID = "a".repeat(40);

function globalHeaderEntry() {
  const data = paxRecord("comment", COMMIT_ID);
  return { name: "pax_global_header", typeflag: "g", size: data.length, data };
}

describe("readTar E1: parseOctal rejects a signed, non-octal, or truncated size", () => {
  it("refuses a 2.5 KB tar whose size field is negative, and does so quickly", () => {
    const bad = ustarHeader({ name: "x", size: "-1000\0\0\0\0\0\0" });
    const tar = padToAtLeast(bad, 2560);
    expect(tar.length).toBeGreaterThanOrEqual(2500);
    expect(tar.length).toBeLessThan(3000);

    const start = Date.now();
    expect(() => readTar(tar)).toThrow(/invalid octal|out of range/i);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("refuses a size field containing a non-octal digit", () => {
    const bad = ustarHeader({ name: "x", size: "1234589\0\0\0\0\0" }); // 8 and 9 aren't octal
    const tar = padToAtLeast(bad, BLOCK_SIZE);
    expect(() => readTar(tar)).toThrow(/invalid octal/i);
  });

  it("refuses a size field with a leading '+' sign", () => {
    const bad = ustarHeader({ name: "x", size: "+100000\0\0\0\0" });
    const tar = padToAtLeast(bad, BLOCK_SIZE);
    expect(() => readTar(tar)).toThrow(/invalid octal/i);
  });

  it("refuses a huge size that would read past the end of the buffer (truncated archive)", () => {
    // Well under the default total-bytes cap, so this exercises the
    // truncation check specifically, not the W3 resource cap.
    const bad = ustarHeader({ name: "x", size: 5_000_000 });
    const tar = padToAtLeast(bad, BLOCK_SIZE);
    expect(() => readTar(tar)).toThrow(/truncated archive/i);
  });

  it("accepts a normal zero-padded octal size", () => {
    const entry = { name: "ok.txt", size: 5, typeflag: "0", data: "hello" };
    const tar = buildRawTar([entry]);
    const { entries } = readTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.toString()).toBe("hello");
  });
});

describe("readTar W3: hard caps on entry count, total bytes, and PAX header size", () => {
  it("refuses when entry count exceeds the configured maximum", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, size: 1, typeflag: "0", data: "x" }));
    const tar = buildRawTar(entries);
    expect(() => readTar(tar, { maxEntries: 3 })).toThrow(/entry count exceeds/i);
    // Well under the cap, the same tar parses fine.
    expect(() => readTar(tar, { maxEntries: 10 })).not.toThrow();
  });

  it("refuses when total entry bytes exceed the configured maximum", () => {
    const entry = { name: "big.bin", size: 2000, typeflag: "0", data: Buffer.alloc(2000, 0x41) };
    const tar = buildRawTar([entry]);
    expect(() => readTar(tar, { maxTotalBytes: 1000 })).toThrow(/total entry bytes exceed/i);
    expect(() => readTar(tar, { maxTotalBytes: 4000 })).not.toThrow();
  });

  it("refuses a PAX header block that exceeds the configured maximum size", () => {
    const bigValue = "x".repeat(5000);
    const data = paxRecord("comment", bigValue);
    const entry = { name: "pax_global_header", typeflag: "g", size: data.length, data };
    const tar = buildRawTar([entry, { name: "ok.txt", size: 2, typeflag: "0", data: "hi" }]);
    expect(() => readTar(tar, { maxPaxHeaderSize: 1000 })).toThrow(/PAX header block exceeds/i);
    expect(() => readTar(tar, { maxPaxHeaderSize: 10000 })).not.toThrow();
  });
});

describe("readTar: global pax commit id and looksLikeTar sniff", () => {
  it("records the commit id from a pax global header", () => {
    const tar = buildRawTar([globalHeaderEntry(), { name: "ok.txt", size: 2, typeflag: "0", data: "hi" }]);
    const { globalRecords } = readTar(tar);
    expect(globalRecords.comment).toBe(COMMIT_ID);
  });

  it("looksLikeTar accepts a real ustar header and rejects arbitrary bytes", () => {
    const tar = buildRawTar([{ name: "ok.txt", size: 2, typeflag: "0", data: "hi" }]);
    expect(looksLikeTar(tar)).toBe(true);
    expect(looksLikeTar(Buffer.from("not a tar file at all, but long enough to pass the length check......"))).toBe(false);
  });
});
