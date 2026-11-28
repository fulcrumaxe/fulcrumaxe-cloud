import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_COMMAND_KINDS, BRIDGE_INCOMPLETE_ACK_PROTOCOL, BRIDGE_REFUSALS, BRIDGE_RESULTS, COMMAND_REFUSALS, ENGINE_COMMAND_MIN_PROTOCOL, EngineCommand, EngineCommandAck, EngineCommandsPullRequest, RootTail, bridgeRootTail, commandSendableTo,
  engineCommandsPullSchemaFor, isBridgeCommandKind, signEngineCommand, verifyEngineCommand,
} from "../src/engineCommands.js";
import { BRIDGE_ENABLE_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION } from "../src/messages.js";
import { JobSignatureError } from "../src/jobSignature.js";

// D#845 ON-BR-2, criteria 1, 4 and 5: the two runner-targeted kinds, their closed arguments, the version gate, the ack's results and the pull's bridge fields.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const ISSUED = "2026-11-19T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(ISSUED) + s * 1000).toISOString();
const base = (over: Record<string, unknown>) => ({ v: 1, purpose: "engine_command_v1", command_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", command_seq: 1, runner_id: "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f", repo_gh_id: 77, issued_by: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", issued_at: ISSUED, expires_at: at(600), halt_epoch: 0, ...over });
const enable = (args: Record<string, unknown>) => base({ kind: "bridge_enable", args });
const disable = (args: Record<string, unknown>) => base({ kind: "bridge_disable", args });
const ok = (value: unknown) => EngineCommand.safeParse(value).success;

describe("bridge_enable and bridge_disable: the shapes", () => {
  it("are command kinds, with repo_gh_id in the signed base", () => {
    expect([...BRIDGE_COMMAND_KINDS]).toEqual(["bridge_enable", "bridge_disable"]);
    expect(isBridgeCommandKind("bridge_enable")).toBe(true);
    expect(isBridgeCommandKind("start_day")).toBe(false);
    expect(ok(enable({}))).toBe(true);
    expect(ok(disable({}))).toBe(true);
    const noRepo = enable({}) as Record<string, unknown>;
    delete noRepo["repo_gh_id"];
    expect(ok(noRepo)).toBe(false);
  });

  it("take a repo_root that is absolute, at most 1,024 characters, with no .. part and no control or bidirectional character", () => {
    expect(ok(enable({ repo_root: "/work/acme/site" }))).toBe(true);
    expect(ok(enable({ repo_root: "/" + "a".repeat(1023) }))).toBe(true);
    const refused: Array<[string, unknown]> = [
      ["relative", "work/site"], ["empty", ""], ["too long", "/" + "a".repeat(1024)], ["dot dot part", "/work/../etc"], ["dot dot at the end", "/work/.."], ["newline", "/work/a\nb"], ["NUL", "/work/a\u0000b"],
      ["bidi override", "/work/a‮b"], ["bidi isolate", "/work/a⁦b"], ["zero width", "/work/a​b"], ["not a string", 7],
    ];
    for (const [why, value] of refused) expect(ok(enable({ repo_root: value })), why).toBe(false);
    // A name that merely contains two dots is not a .. part.
    expect(ok(enable({ repo_root: "/work/a..b" }))).toBe(true);
  });

  it("refuse an extra key, and bridge_disable takes no arguments", () => {
    expect(ok(enable({ repo_root: "/work/site", extra: 1 }))).toBe(false);
    expect(ok(enable({ note: "x" }))).toBe(false);
    expect(ok(disable({ repo_root: "/work/site" }))).toBe(false);
    expect(ok({ ...enable({}), kind: "start_day", args: { repo_root: "/work/site" } })).toBe(false);
  });

  it("are signed with the same key and purpose: the real Ed25519 path, and a changed repo_root fails verification", () => {
    const signed = signEngineCommand(EngineCommand.parse(enable({ repo_root: "/work/acme/site" })), "job-key-1", privateKey);
    const now = new Date(ISSUED);
    const good = verifyEngineCommand(signed, keyring, now);
    expect(good.kind).toBe("bridge_enable");
    expect(good.purpose).toBe("engine_command_v1");
    const swapped = { ...signed, command: { ...signed.command, args: { repo_root: "/work/acme/other" } } };
    expect(() => verifyEngineCommand(swapped, keyring, now)).toThrow(JobSignatureError);
    try {
      verifyEngineCommand(swapped, keyring, now);
    } catch (error) {
      expect((error as JobSignatureError).code).toBe("bad_signature");
    }
    const dropped = { ...signed, command: { ...signed.command, args: {} } };
    expect(() => verifyEngineCommand(dropped, keyring, now)).toThrow(JobSignatureError);
    const other = signEngineCommand(EngineCommand.parse(disable({})), "job-key-1", privateKey);
    expect(verifyEngineCommand(other, keyring, now).kind).toBe("bridge_disable");
  });

  it("live at most 600 s", () => {
    expect(ok({ ...enable({}), expires_at: at(600) })).toBe(true);
    expect(ok({ ...enable({}), expires_at: at(601) })).toBe(false);
  });
});

describe("the protocol gate", () => {
  it("is 24, the highest minimum in the file (the version since is 28, the current one)", () => {
    expect(BRIDGE_ENABLE_MIN_PROTOCOL).toBe(24);
    expect(CURRENT_PROTOCOL_VERSION).toBe(28);
    const text = readFileSync(new URL("../src/messages.ts", import.meta.url), "utf8");
    const mins = [...text.matchAll(/export const [A-Z_]*MIN_PROTOCOL = (\d+);/g)].map((m) => ({ name: m[0], n: Number(m[1]) }));
    const highest = Math.max(...mins.map((m) => m.n));
    expect(highest).toBe(BRIDGE_ENABLE_MIN_PROTOCOL);
    expect(mins.filter((m) => m.n === highest).map((m) => m.name.split(" ")[2])).toEqual(["BRIDGE_ENABLE_MIN_PROTOCOL"]);
  });

  it("is never sent to a hello below 24, and goes to 24", () => {
    for (const kind of BRIDGE_COMMAND_KINDS) {
      expect(ENGINE_COMMAND_MIN_PROTOCOL[kind]).toBe(24);
      for (const hello of [20, 22, 23]) expect(commandSendableTo(kind, hello), `${kind} at ${hello}`).toBe(false);
      for (const hello of [24, 25, 26]) expect(commandSendableTo(kind, hello), `${kind} at ${hello}`).toBe(true);
    }
    // The older kinds are unchanged.
    expect(commandSendableTo("start_day", 20)).toBe(true);
    expect(commandSendableTo("watch", 22)).toBe(false);
  });

  it("ON-BR-4: incomplete is additive and from protocol 26: an ack without the key parses as before", () => {
    expect(BRIDGE_INCOMPLETE_ACK_PROTOCOL).toBe(26);
    expect(BRIDGE_INCOMPLETE_ACK_PROTOCOL).toBeLessThanOrEqual(CURRENT_PROTOCOL_VERSION);
    expect(EngineCommandAck.safeParse({ outcome: "refused", refusal: "checkout_not_found", result: "not_found" }).success).toBe(true);
  });

  it("is told in the version history on the protocol version", () => {
    const text = readFileSync(new URL("../src/messages.ts", import.meta.url), "utf8");
    expect(text).toContain("Version 24 is the first whose runner takes the signed `bridge_enable` and `bridge_disable` commands");
  });
});

describe("the ack's results", () => {
  const parse = (value: unknown) => EngineCommandAck.safeParse(value);
  const dirs = Array.from({ length: 10 }, (_, i) => `/work/clone-${i}/site`);

  it("accepts each result in its own shape", () => {
    expect(parse({ outcome: "applied", result: "connected", root_tail: "acme/site" }).success).toBe(true);
    expect(parse({ outcome: "applied", result: "already_connected" }).success).toBe(true);
    expect(parse({ outcome: "applied", result: "already_connected", root_tail: "acme/site" }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "checkout_not_found", result: "not_found" }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "checkout_not_found", result: "not_found", skipped: ["/work/skipped/site"] }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "checkout_not_found", result: "not_found", incomplete: true }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "checkout_not_found", result: "not_found", skipped: ["/work/skipped/site"], incomplete: true }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: dirs }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "checkout_incomplete", result: "refused", candidates: ["/work/one/site"] }).success).toBe(true);
    for (const refusal of BRIDGE_REFUSALS.filter((r) => r !== "checkout_not_found" && r !== "checkout_ambiguous")) expect(parse({ outcome: "refused", refusal, result: "refused" }).success, refusal).toBe(true);
    // The acks every command had still parse.
    expect(parse({ outcome: "applied" }).success).toBe(true);
    expect(parse({ outcome: "refused", refusal: "seq_not_increasing" }).success).toBe(true);
    expect(parse({ outcome: "not_confirmed" }).success).toBe(true);
  });

  it("refuses an unknown result, an extra key and every inconsistent pairing", () => {
    expect(parse({ outcome: "applied", result: "teleported" }).success).toBe(false);
    expect(parse({ outcome: "applied", result: "connected", root_tail: "a/b", extra: 1 }).success).toBe(false);
    const bad: Array<[string, unknown]> = [
      ["connected without a folder", { outcome: "applied", result: "connected" }],
      ["connected but refused", { outcome: "refused", refusal: "bridge_failed", result: "connected", root_tail: "a/b" }],
      ["not_found but applied", { outcome: "applied", result: "not_found" }],
      ["not_found with the wrong refusal", { outcome: "refused", refusal: "wrong_repo", result: "not_found" }],
      ["ambiguous with one folder", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/a"] }],
      ["ambiguous with none", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous" }],
      ["ambiguous with 11", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: [...dirs, "/work/clone-10/site"] }],
      ["refused with a non-bridge reason", { outcome: "refused", refusal: "ceiling", result: "refused" }],
      ["refused with not_found's reason", { outcome: "refused", refusal: "checkout_not_found", result: "refused" }],
      ["a folder with no result", { outcome: "applied", root_tail: "a/b" }],
      ["candidates with no result", { outcome: "refused", refusal: "checkout_ambiguous", candidates: ["/work/a", "/work/b"] }],
      ["not_found offering a folder to pick", { outcome: "refused", refusal: "checkout_not_found", result: "not_found", candidates: ["/work/a"] }],
      ["skipped on another result", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/a", "/work/b"], skipped: ["/work/c"] }],
      ["incomplete on another result", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/a", "/work/b"], incomplete: true }],
      ["incomplete on a refused result", { outcome: "refused", refusal: "checkout_incomplete", result: "refused", candidates: ["/work/a"], incomplete: true }],
      ["incomplete with no result", { outcome: "refused", refusal: "bridge_failed", incomplete: true }],
      ["incomplete false", { outcome: "refused", refusal: "checkout_not_found", result: "not_found", incomplete: false }],
      ["incomplete as text", { outcome: "refused", refusal: "checkout_not_found", result: "not_found", incomplete: "true" }],
      ["skipped with no result", { outcome: "refused", refusal: "bridge_failed", skipped: ["/work/c"] }],
      ["a connected repo offering folders", { outcome: "applied", result: "connected", root_tail: "a/b", candidates: ["/work/a"] }],
      ["a root_tail of three parts", { outcome: "applied", result: "connected", root_tail: "a/b/c" }],
      ["an absolute root_tail", { outcome: "applied", result: "connected", root_tail: "/a/b" }],
      ["a relative candidate", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["work/a", "work/b"] }],
      ["a candidate with ..", { outcome: "refused", refusal: "checkout_ambiguous", result: "ambiguous", candidates: ["/work/../a", "/work/b"] }],
      ["an applied ack with a refusal", { outcome: "applied", refusal: "bridge_failed", result: "already_connected" }],
    ];
    for (const [why, value] of bad) expect(parse(value).success, why).toBe(false);
  });

  it("knows the same results the database does, and the bridge refusals are command refusals", () => {
    expect([...BRIDGE_RESULTS]).toEqual(["connected", "not_found", "ambiguous", "refused", "already_connected"]);
    for (const r of BRIDGE_REFUSALS) expect(COMMAND_REFUSALS).toContain(r);
    const sql = readFileSync(new URL("../../db/migrations/1042_engine_bridge_connect.sql", import.meta.url), "utf8");
    for (const r of COMMAND_REFUSALS) expect(sql.includes(`'${r}'`) || ["signature_invalid", "wrong_runner"].includes(r), r).toBe(true);
    for (const r of BRIDGE_RESULTS) expect(sql).toContain(`'${r}'`);
  });

  it("keeps only the last two parts of a folder in a root tail", () => {
    expect(bridgeRootTail("/home/me/work/acme/site")).toBe("acme/site");
    expect(bridgeRootTail("/site")).toBe("site");
    expect(bridgeRootTail("/a/b/c/")).toBe("b/c");
    expect(RootTail.safeParse("acme/site").success).toBe(true);
    expect(RootTail.safeParse("a/b/c").success).toBe(false);
    expect(RootTail.safeParse("a/../b").success).toBe(false);
    expect(RootTail.safeParse("a\nb").success).toBe(false);
  });
});

describe("the pull's bridge fields", () => {
  const pull = { repo_gh_ids: [9007199254740991], after_seq: {} };

  it("exist at protocol 24 and are refused by the strict parse of an older hello", () => {
    const v24 = engineCommandsPullSchemaFor(24);
    const v23 = engineCommandsPullSchemaFor(23);
    expect(v24.safeParse(pull).success).toBe(true);
    expect(v23.safeParse(pull).success).toBe(true);
    const withBridged = { ...pull, bridged: [{ repo_gh_id: 77, root: "/work/acme/site" }], bridge_commands: true };
    expect(v24.safeParse(withBridged).success).toBe(true);
    expect(v23.safeParse(withBridged).success).toBe(false);
    expect(v23.safeParse({ ...pull, bridged: [] }).success).toBe(false);
    expect(v23.safeParse({ ...pull, bridge_commands: true }).success).toBe(false);
    expect(EngineCommandsPullRequest.safeParse(withBridged).success).toBe(true);
  });

  it("holds a repo once, at most ten, with a root that is a plain absolute folder", () => {
    const v24 = engineCommandsPullSchemaFor(24);
    expect(v24.safeParse({ ...pull, bridged: [{ repo_gh_id: 1 }, { repo_gh_id: 1 }] }).success).toBe(false);
    expect(v24.safeParse({ ...pull, bridged: Array.from({ length: 11 }, (_, i) => ({ repo_gh_id: i + 1 })) }).success).toBe(false);
    expect(v24.safeParse({ ...pull, bridged: [{ repo_gh_id: 1, root: "relative" }] }).success).toBe(false);
    expect(v24.safeParse({ ...pull, bridged: [{ repo_gh_id: 1, root: "/work/../x" }] }).success).toBe(false);
    expect(v24.safeParse({ ...pull, bridged: [{ repo_gh_id: 1, extra: true }] }).success).toBe(false);
    expect(v24.safeParse({ ...pull, bridge_commands: false }).success).toBe(false);
  });
});
