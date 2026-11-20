import { describe, expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION, HANDOFF_MIN_PROTOCOL_VERSION, HelloReply, MIN_SUPPORTED_PROTOCOL_VERSION, WATCH_MODE_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { HANDOFF_PROTOCOL_VERSION } from "../src/handoff.js";
import { protocolVersionSupported } from "../src/hello.js";

describe("which protocol versions hello accepts", () => {
  it("accepts every version from the floor up to the current one with the real constants", () => {
    for (let version = MIN_SUPPORTED_PROTOCOL_VERSION; version <= CURRENT_PROTOCOL_VERSION; version++) expect(protocolVersionSupported(version), String(version)).toBe(true);
  });

  it("a version-1 runner is still accepted after the version moved past 2", () => {
    expect(protocolVersionSupported(1, 3, 1)).toBe(true);
    expect(protocolVersionSupported(1, 9, 1)).toBe(true);
  });

  it("refuses one above the current version, and one below the floor", () => {
    expect(protocolVersionSupported(CURRENT_PROTOCOL_VERSION + 1)).toBe(false);
    expect(protocolVersionSupported(MIN_SUPPORTED_PROTOCOL_VERSION - 1)).toBe(false);
    expect(protocolVersionSupported(0)).toBe(false);
  });

  it("takes both bounds as parameters: below the floor and above the current are refused, the edges are not", () => {
    expect(protocolVersionSupported(1, 4, 2)).toBe(false);
    expect(protocolVersionSupported(2, 4, 2)).toBe(true);
    expect(protocolVersionSupported(4, 4, 2)).toBe(true);
    expect(protocolVersionSupported(5, 4, 2)).toBe(false);
  });

  it("gates a handoff on the protocol package's own constant: one threshold, not two that can drift", () => {
    expect(HANDOFF_PROTOCOL_VERSION).toBe(HANDOFF_MIN_PROTOCOL_VERSION);
    expect(protocolVersionSupported(HANDOFF_PROTOCOL_VERSION)).toBe(true);
  });

  it("the hello reply's capabilities are a closed set: watch_mode alone, once; anything else, a repeat or a non-list is refused", () => {
    expect(HelloReply.parse({ protocol_version: 24, capabilities: [WATCH_MODE_CAPABILITY] })).toEqual({ protocol_version: 24, capabilities: ["watch_mode"] });
    expect(HelloReply.parse({ protocol_version: 24 })).toEqual({ protocol_version: 24 });
    for (const bad of [["slim"], ["watch_mode", "watch_mode"], ["watch_mode", "other"], "watch_mode", [1]]) expect(() => HelloReply.parse({ protocol_version: 24, capabilities: bad }), JSON.stringify(bad)).toThrow();
  });
});
