import { describe, expect, it } from "vitest";
import { loadPinned, renderUnit, runtimeDirPath, socketPath, type Pinned, type UnitParams } from "../../src/vm/unitRender.js";
import { cases, goldenUnit, pinnedFile } from "./helpers/unitCases.js";

const params: UnitParams = cases[0]!.params;

describe("the TypeScript unit renderer against the Go golden files", () => {
  it("has the golden cases it compares", () => {
    expect(cases.map((c) => c.name)).toEqual(["with-group", "no-group"]);
  });
  for (const c of cases) {
    it(`renders ${c.name} byte for byte as RenderUnit does`, () => {
      expect(renderUnit(c.params)).toBe(goldenUnit(c.name));
    });
  }

  it("takes every directive and capability from hardening.json, so a changed file changes the unit", () => {
    const changed: Pinned = {
      ...pinnedFile,
      directives: { ...pinnedFile.directives, ProtectSystem: "full", ExtraDirective: ["one", "two"] },
      capabilities: [...pinnedFile.capabilities, { name: "CAP_FAKE", number: 63, reason: "test" }],
    };
    const text = renderUnit(params, loadPinned(changed));
    expect(text).toContain("ProtectSystem=full\n");
    expect(text).toContain("ExtraDirective=one\nExtraDirective=two\n");
    expect(text).toMatch(/CapabilityBoundingSet=.* CAP_FAKE\n/);
    expect(text).not.toBe(renderUnit(params));
  });

  it("derives the socket and runtime paths from the file", () => {
    expect(runtimeDirPath()).toBe(`/run/${pinnedFile.runtime_directory}`);
    expect(socketPath()).toBe(`/run/${pinnedFile.runtime_directory}/${pinnedFile.socket_name}`);
  });

  it.each([
    ["a space", { ...params, helperPath: "/opt/a b" }],
    ["a semicolon", { ...params, configPath: "/etc/x;y" }],
    ["a percent", { ...params, jailRoot: "/var/%h" }],
    ["a relative path", { ...params, jailRoot: "var/jail" }],
    ["a trailing slash", { ...params, jailRoot: "/var/jail/" }],
    ["a dot segment", { ...params, jailRoot: "/var/../jail" }],
    ["the root", { ...params, jailRoot: "/" }],
    ["a relative snapshot dir", { ...params, snapshotDir: "snap" }],
    ["a space in the snapshot dir", { ...params, snapshotDir: "/var/a b" }],
    ["a newline in the group", { ...params, group: "g\nExecStartPre=/bin/sh" }],
    ["a quote in the group", { ...params, group: 'g"' }],
  ])("refuses %s before it writes a line", (_name, bad) => {
    expect(() => renderUnit(bad)).toThrow("unit parameters must be clean absolute paths and a plain group name");
  });

  it("refuses a malformed hardening file", () => {
    expect(() => loadPinned({ ...pinnedFile, capabilities: [] })).toThrow("hardening.json");
    expect(() => loadPinned({ ...pinnedFile, runtime_directory_mode: "rwx" })).toThrow("hardening.json");
    expect(() => loadPinned(null)).toThrow("hardening.json");
  });
});
