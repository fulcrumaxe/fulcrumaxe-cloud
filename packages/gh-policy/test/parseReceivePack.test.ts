import { describe, expect, it } from "vitest";
import { parseReceivePackRefUpdates } from "../src/parseReceivePack.js";
import {
  buildReceivePackBody,
  buildReceivePackBodyWithShallow,
  buildUnterminatedReceivePackBody,
  SHA_A,
  SHA_B,
  ZERO_SHA,
} from "./fixtures.js";

describe("parseReceivePackRefUpdates", () => {
  it("parses a single ref update with a capabilities suffix, complete: true", () => {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }]);
    const result = parseReceivePackRefUpdates(body);
    expect(result).toEqual({
      updates: [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
      complete: true,
    });
  });

  it("parses multiple ref updates in one push, complete: true", () => {
    const body = buildReceivePackBody([
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
      { old: SHA_A, new: SHA_B, ref: "refs/heads/fx/H04" },
    ]);
    const result = parseReceivePackRefUpdates(body);
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
      { old: SHA_A, new: SHA_B, ref: "refs/heads/fx/H04" },
    ]);
  });

  it("stops at the flush-pkt and ignores anything after it (pack data), still complete: true", () => {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }]);
    const withPackData = new Uint8Array([...body, 0x50, 0x41, 0x43, 0x4b]); // "PACK"
    const result = parseReceivePackRefUpdates(withPackData);
    expect(result.complete).toBe(true);
    expect(result.updates).toHaveLength(1);
  });

  it("returns complete: true with zero updates for a bare flush-pkt", () => {
    const result = parseReceivePackRefUpdates(new TextEncoder().encode("0000"));
    expect(result).toEqual({ updates: [], complete: true });
  });

  it("returns complete: false for an empty body (never reaches a flush-pkt)", () => {
    expect(parseReceivePackRefUpdates(new Uint8Array())).toEqual({ updates: [], complete: false });
  });

  it("[H03 fix round item 8] returns complete: false for an unterminated section, not just the updates it did see", () => {
    const updates = [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }];
    const body = buildUnterminatedReceivePackBody(updates);
    const result = parseReceivePackRefUpdates(body);
    // The one well-formed line it saw is still reported...
    expect(result.updates).toEqual(updates);
    // ...but completeness must be false: there was no flush-pkt, so a
    // caller cannot treat this as "the whole push".
    expect(result.complete).toBe(false);
  });

  it("[H03 fix round item 8] stops (complete: false) on a length prefix that claims more bytes than the body has, rather than silently truncating", () => {
    // "0010" claims a 16-byte line, but nothing follows it.
    const truncated = new TextEncoder().encode("0010");
    const result = parseReceivePackRefUpdates(truncated);
    expect(result).toEqual({ updates: [], complete: false });
  });

  it("[H03 fix round item 8] stops (complete: false) on a length prefix smaller than the 4-byte header itself", () => {
    const bad = new TextEncoder().encode("0002xx");
    expect(parseReceivePackRefUpdates(bad)).toEqual({ updates: [], complete: false });
  });

  it("[H03 fix round item 8] stops (complete: false) on a non-hex length prefix instead of skipping it", () => {
    const bad = new TextEncoder().encode("zzzznotalength");
    expect(() => parseReceivePackRefUpdates(bad)).not.toThrow();
    expect(parseReceivePackRefUpdates(bad)).toEqual({ updates: [], complete: false });
  });

  it("[H03 fix round item 8] stops (complete: false) on a line with fewer than 3 fields, rather than silently skipping it", () => {
    const encoder = new TextEncoder();
    const payload = "garbage\n";
    const len = payload.length + 4;
    const line = encoder.encode(len.toString(16).padStart(4, "0") + payload);
    const flush = encoder.encode("0000");
    const body = new Uint8Array([...line, ...flush]);
    const result = parseReceivePackRefUpdates(body);
    expect(result.complete).toBe(false);
    expect(result.updates).toEqual([]);
  });

  it("[H03 fix round item 8] stops (complete: false) on a line with MORE than 3 fields", () => {
    // A ref containing a literal space is never valid, but the parser
    // itself must not silently absorb the extra field either.
    const encoder = new TextEncoder();
    const payload = `${ZERO_SHA} ${SHA_A} refs/heads/fx/H 03\n`;
    const len = payload.length + 4;
    const line = encoder.encode(len.toString(16).padStart(4, "0") + payload);
    const flush = encoder.encode("0000");
    const body = new Uint8Array([...line, ...flush]);
    const result = parseReceivePackRefUpdates(body);
    expect(result.complete).toBe(false);
  });

  // [H03 fix round 2, suggestion] A push from a shallow clone sends one or
  // more `shallow <sha>` lines ahead of the ref-update commands. These are
  // informational, not ref updates — recognized and skipped, never treated
  // as a malformed line and never pushed onto `updates`.
  it("[round 2] parses and skips a single shallow line ahead of the ref update", () => {
    const body = buildReceivePackBodyWithShallow(
      [SHA_B],
      [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
    );
    const result = parseReceivePackRefUpdates(body);
    expect(result).toEqual({
      updates: [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
      complete: true,
    });
  });

  it("[round 2] parses and skips multiple shallow lines ahead of multiple ref updates", () => {
    const body = buildReceivePackBodyWithShallow(
      [SHA_A, SHA_B],
      [
        { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
        { old: SHA_A, new: SHA_B, ref: "refs/heads/fx/H04" },
      ],
    );
    const result = parseReceivePackRefUpdates(body);
    expect(result.complete).toBe(true);
    expect(result.updates).toEqual([
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
      { old: SHA_A, new: SHA_B, ref: "refs/heads/fx/H04" },
    ]);
  });

  it("[round 2] a shallow-only push (no ref updates at all) still parses as complete with zero updates", () => {
    const body = buildReceivePackBodyWithShallow([SHA_A], []);
    const result = parseReceivePackRefUpdates(body);
    expect(result).toEqual({ updates: [], complete: true });
  });

  it("[round 2] a malformed 'shallow' line (bad sha shape) is NOT silently treated as valid", () => {
    const encoder = new TextEncoder();
    const payload = "shallow not-a-real-sha\n";
    const len = payload.length + 4;
    const line = encoder.encode(len.toString(16).padStart(4, "0") + payload);
    const flush = encoder.encode("0000");
    const body = new Uint8Array([...line, ...flush]);
    const result = parseReceivePackRefUpdates(body);
    expect(result.complete).toBe(false);
  });

  // [H03 fix round 3, suggestion] Tightened from "4 to 64 hex chars" to
  // git's two real object-id lengths (40 for SHA-1, 64 for SHA-256).
  it("[round 3] a 64-hex-char (SHA-256-length) shallow line still parses as valid", () => {
    const sha256Sized = "f".repeat(64);
    const body = buildReceivePackBodyWithShallow(
      [sha256Sized],
      [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
    );
    const result = parseReceivePackRefUpdates(body);
    expect(result).toEqual({
      updates: [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
      complete: true,
    });
  });

  it("[round 3] a shallow line with a hex length that is neither 40 nor 64 is no longer accepted as valid", () => {
    // The pre-round-3 regex accepted anything from 4 to 64 hex characters,
    // so a 4-char hex run like "abcd" — not a length git's object-id
    // format ever actually produces — was silently treated as a
    // well-formed shallow line.
    const encoder = new TextEncoder();
    const payload = "shallow abcd\n";
    const len = payload.length + 4;
    const line = encoder.encode(len.toString(16).padStart(4, "0") + payload);
    const flush = encoder.encode("0000");
    const body = new Uint8Array([...line, ...flush]);
    const result = parseReceivePackRefUpdates(body);
    expect(result.complete).toBe(false);
  });
});
