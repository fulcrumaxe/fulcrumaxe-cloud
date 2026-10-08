import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceStore } from "../src/job/workspace.js";

const root = () => path.join(mkdtempSync(path.join(tmpdir(), "r4b13_wsroot-")), "workspaces");

describe("workspace store", () => {
  it("makes an empty private directory per run, directly under its root", async () => {
    const store = createWorkspaceStore(root());
    const dir = await store.create("run-1");
    expect(path.basename(dir)).toBe("run-1");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a second workspace for the same run, and run ids that could leave the root", async () => {
    const store = createWorkspaceStore(root());
    await store.create("run-1");
    await expect(store.create("run-1")).rejects.toThrow("already exists");
    for (const bad of ["", "..", "../x", "a/b", ".hidden", "x".repeat(129), "a b", ".", "x..y"]) await expect(store.create(bad), bad).rejects.toThrow(TypeError);
  });

  it("discards a workspace it made, idempotently, and nothing else", async () => {
    const r = root();
    const store = createWorkspaceStore(r);
    const dir = await store.create("run-1");
    await store.discard(dir);
    expect(existsSync(dir)).toBe(false);
    await store.discard(dir);
    const outside = mkdtempSync(path.join(tmpdir(), "r4b13_outside-"));
    for (const target of [outside, r, path.join(r, "run-1", "sub"), path.join(r, "..")]) await expect(store.discard(target), target).rejects.toThrow(TypeError);
    expect(existsSync(outside)).toBe(true);
  });

  it("needs an absolute root", () => {
    expect(() => createWorkspaceStore("relative/root")).toThrow(TypeError);
  });
});
