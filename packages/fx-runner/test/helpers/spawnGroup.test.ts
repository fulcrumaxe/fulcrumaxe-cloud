import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killAllGroups, pidsWithCommandLine, runGrouped } from "./spawnGroup.js";

const roots: string[] = [];
afterEach(() => {
  killAllGroups();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const linux = process.platform === "linux";

/** A fake tool in a directory whose name nothing else has, so its processes can be found by that path alone. */
function stub(body: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `fxr-grp-${randomBytes(6).toString("hex")}-`));
  roots.push(dir);
  const file = path.join(dir, "tool");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return { dir, file };
}

describe("runGrouped", () => {
  it("returns the output and code of a tool that finishes", async () => {
    const s = stub('echo out; echo err >&2; exit 3');
    const r = await runGrouped(s.file, [], { PATH: "/bin:/usr/bin" }, { timeoutMs: 10_000 });
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it.skipIf(!linux)("kills a tool that never exits, and its children, at the deadline", async () => {
    // The shell loops forever and also starts a background child, as install.sh does with curl.
    const s = stub('"$0" child & while :; do :; done');
    const started = Date.now();
    const r = await runGrouped(s.file, [], { PATH: "/bin:/usr/bin" }, { timeoutMs: 700 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(pidsWithCommandLine(s.dir)).toEqual([]);
  });

  it.skipIf(!linux)("kills a child that outlives its parent when the parent exits normally", async () => {
    const s = stub('if [ "$1" = child ]; then while :; do :; done; fi\n"$0" child &\nexit 0');
    const r = await runGrouped(s.file, [], { PATH: "/bin:/usr/bin" }, { timeoutMs: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(pidsWithCommandLine(s.dir)).toEqual([]);
  });

  it.skipIf(!linux)("a sweep in afterEach kills groups still running", async () => {
    const s = stub("while :; do :; done");
    const pending = runGrouped(s.file, [], { PATH: "/bin:/usr/bin" }, { timeoutMs: 60_000 });
    for (let i = 0; i < 100 && pidsWithCommandLine(s.dir).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(pidsWithCommandLine(s.dir).length).toBeGreaterThan(0);
    killAllGroups();
    expect((await pending).timedOut).toBe(false);
    expect(pidsWithCommandLine(s.dir)).toEqual([]);
  });
});
