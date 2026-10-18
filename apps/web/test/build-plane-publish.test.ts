import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMissingHook } from "../scripts/check-baked-paths.mjs";
import { GENERATED_FILE, bundlePlanePublishHook, buildPlanePublish } from "../scripts/build-plane-publish.mjs";
import { PLANE_PUBLISH_HOOK_SHA256, PLANE_PUBLISH_HOOK_SOURCE } from "../app/_generated/plane-publish-hook";
import { createPlanePublishPorts } from "../lib/github/planePublish";

/**
 * D#598 P1f-5b: the publish hook is a BUILD product. The worker writes its text into a sandbox, so it must come from the built bundle (compiled into
 * the server output), must hold no build-machine path, and must run from a directory other than the one it was built in.
 */
describe("the publish hook build step", () => {
  let moved: string;
  beforeEach(() => {
    moved = fs.mkdtempSync(path.join(os.tmpdir(), "p15b-moved-"));
  });
  afterEach(() => fs.rmSync(moved, { recursive: true, force: true }));

  it("writes a generated module whose text hashes to its recorded sha256, and the worker's port serves exactly that text", () => {
    const r = buildPlanePublish();
    expect(fs.existsSync(GENERATED_FILE)).toBe(true);
    expect(r.sha256).toBe(createHash("sha256").update(PLANE_PUBLISH_HOOK_SOURCE).digest("hex"));
    expect(PLANE_PUBLISH_HOOK_SHA256).toBe(r.sha256);
    expect(createPlanePublishPorts({ NODE_ENV: "test" }).hook()).toBe(PLANE_PUBLISH_HOOK_SOURCE);
  });

  it("the bundle holds neither the checkout's path nor an environment read of a secret, and runs from another directory (no input: one closed refusal)", () => {
    const text = bundlePlanePublishHook();
    expect(text).not.toContain(path.resolve(__dirname, "../../.."));
    expect(text).not.toMatch(/process\.env\.(FX_|GH_|ANTHROPIC)/);
    const file = path.join(moved, "fx-plane-publish.mjs");
    fs.writeFileSync(file, text);
    // The sandbox's input file does not exist here, so the entry says one closed line and ends.
    const out = execFileSync("node", [file], { cwd: moved, encoding: "utf8" });
    expect(out.trim().split("\n")).toEqual(['{"fx":"plane_publish","phase":"refused","code":"bad_input"}']);
  });

  it("check-baked-paths fails when the hook's sha256 is nowhere in the server output, or the generated module is missing", () => {
    const server = path.join(moved, "server");
    fs.mkdirSync(path.join(server, "chunks"), { recursive: true });
    const gen = path.join(moved, "plane-publish-hook.ts");
    const find = findMissingHook as (dir: string, gen: string) => string[];
    expect(find(server, gen)[0]).toMatch(/generated hook module .* is missing/);
    fs.writeFileSync(gen, `export const PLANE_PUBLISH_HOOK_SHA256: string = "${"a".repeat(64)}";\n`);
    expect(find(server, gen)).toEqual(["the publish hook is not compiled into .next/server (its sha256 appears nowhere)"]);
    fs.writeFileSync(path.join(server, "chunks", "1.js"), `x="${"a".repeat(64)}"`);
    expect(find(server, gen)).toEqual([]);
  });
});
