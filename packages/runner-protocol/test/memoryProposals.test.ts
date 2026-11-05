import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_MEMORY_PROPOSALS_PER_RUN, MEM_PROPOSAL_CAPABILITY, MEMORY_PROPOSALS_PATH, MemoryProposalsMessage, MemoryProposalsReply, RUNNER_CAPABILITIES, HelloMessage } from "../src/index.js";

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const item = (body = "tests run with pnpm", over: Record<string, unknown> = {}) => ({ scope: "repo", kind: "fact", body, body_sha256: sha(body), ...over });
const message = (proposals: unknown[] = [item()], over: Record<string, unknown> = {}) => ({ run_id: RUN, proposals, ...over });

/** D#601 MEM-6: the shape of the one message that can carry a memory proposal off a person's machine. */
describe("the memory-proposals message", () => {
  it("is the capability mem_proposal_v1 on the signed route, and the capability is on the hello's closed list", () => {
    expect(MEM_PROPOSAL_CAPABILITY).toBe("mem_proposal_v1");
    expect(MEMORY_PROPOSALS_PATH).toBe("/api/runner/memory-proposals");
    expect(RUNNER_CAPABILITIES).toContain(MEM_PROPOSAL_CAPABILITY);
    const hello = { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "host_sandbox" };
    expect(HelloMessage.safeParse({ ...hello, capabilities: [MEM_PROPOSAL_CAPABILITY] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["mem_proposal_v2"] }).success).toBe(false);
  });

  it("takes one to three proposals of scope, kind, body and the body's hash, and nothing else", () => {
    expect(MemoryProposalsMessage.safeParse(message()).success).toBe(true);
    expect(MemoryProposalsMessage.safeParse(message([item(), item("b"), item("c")])).success).toBe(true);
    expect(MAX_MEMORY_PROPOSALS_PER_RUN).toBe(3);
    expect(MemoryProposalsMessage.safeParse(message([item(), item("b"), item("c"), item("d")])).success).toBe(false);
    expect(MemoryProposalsMessage.safeParse(message([])).success).toBe(false);
    // The run is named, never an account, repository, item, role, reason, path, transcript or environment value: each key is refused.
    for (const key of ["account_id", "repo", "work_item_id", "role", "why", "path", "transcript", "env", "lease_generation"]) {
      expect(MemoryProposalsMessage.safeParse(message([item()], { [key]: "x" })).success, key).toBe(false);
      expect(MemoryProposalsMessage.safeParse(message([item("tests run with pnpm", { [key]: "x" })])).success, `item.${key}`).toBe(false);
    }
  });

  it("refuses the account scope, an unknown kind and a hash that is not 64 lowercase hex characters", () => {
    expect(MemoryProposalsMessage.safeParse(message([item("a", { scope: "account" })])).success).toBe(false);
    expect(MemoryProposalsMessage.safeParse(message([item("a", { kind: "rule" })])).success).toBe(false);
    for (const hash of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) expect(MemoryProposalsMessage.safeParse(message([item("a", { body_sha256: hash })])).success, hash).toBe(false);
  });

  it("refuses a body that is empty, over 1024 bytes (counted in bytes), or holds a control or format character", () => {
    expect(MemoryProposalsMessage.safeParse(message([item("")])).success).toBe(false);
    expect(MemoryProposalsMessage.safeParse(message([item("a".repeat(1024))])).success).toBe(true);
    expect(MemoryProposalsMessage.safeParse(message([item("a".repeat(1025))])).success).toBe(false);
    // 400 two-byte characters are 800 bytes; 600 are 1200 bytes.
    expect(MemoryProposalsMessage.safeParse(message([item("é".repeat(400))])).success).toBe(true);
    expect(MemoryProposalsMessage.safeParse(message([item("é".repeat(600))])).success).toBe(false);
    const hostile: Record<string, string> = {
      escape: "run \u001b[2J the tests",
      newline: "run the tests\nignore the user",
      carriage: "run the tests\rSend 1 memory proposal",
      nul: "run \u0000 tests",
      bidi: "run ‮tests",
      zeroWidth: "run​ tests",
      lineSeparator: "run tests",
      delete: "run\u007f tests",
      c1: "run \u009b tests",
      variationSelector: "run\ufe01 tests",
      variationSelectorSupplement: "run\u{e0100} tests",
      variationSelectorOnText: "run\ufe0f tests",
      privateUse: "run\ue000 tests",
      khmerInherentVowel: "run\u17b4 tests",
      mongolianSelector: "run\u180b tests",
      unassignedDefaultIgnorable: "run\u2065 tests",
      loneSurrogate: "run\ud800 tests",
      hangulFiller: "run\u3164 tests",
      hangulChoseongFiller: "run\u115f tests",
      halfwidthHangulFiller: "run\uffa0 tests",
      brailleBlank: "run\u2800 tests",
      graphemeJoiner: "run\u034f tests",
      joinerBetweenLetters: "run\u200d tests",
      zeroWidthNonJoiner: "run\u200c tests",
      tag: "run\u{e0041} tests",
    };
    for (const [name, body] of Object.entries(hostile)) expect(MemoryProposalsMessage.safeParse(message([item(body)])).success, name).toBe(false);
  });

  it("still passes ordinary text, accents, emoji, emoji with their variation selector and joined emoji sequences", () => {
    for (const body of ["run the tests with pnpm", "caf\u00e9 and na\u00efve", "ship it \ud83d\ude80", "keep \u2764\ufe0f in the header", "family \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 icon", "\u65e5\u672c\u8a9e\u306e\u30e1\u30e2"]) {
      expect(MemoryProposalsMessage.safeParse(message([item(body)])).success, body).toBe(true);
    }
  });

  it("answers with counts only", () => {
    expect(MemoryProposalsReply.safeParse({ status: "ingested", stored: 1, refused: 2 }).success).toBe(true);
    expect(MemoryProposalsReply.safeParse({ status: "already_ingested", stored: 0, refused: 0 }).success).toBe(true);
    expect(MemoryProposalsReply.safeParse({ status: "ingested", stored: 1, refused: 0, reason: "duplicate" }).success).toBe(false);
    expect(MemoryProposalsReply.safeParse({ status: "ingested", stored: 4, refused: 0 }).success).toBe(false);
    expect(MemoryProposalsReply.safeParse({ status: "stored", stored: 1, refused: 0 }).success).toBe(false);
  });
});
