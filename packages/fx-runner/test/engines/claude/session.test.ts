import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { planSession, readSessionIndex, recordSession } from "../../../src/engines/claude/session.js";
import { engineFor, fixtureText, makeRig } from "./rig.js";

const continues = { session_id: "sess-0001", branch: "fx/fix-1" };
const index = { "sess-0001": { workspace: "/work/a" } };

describe("session planning", () => {
  it.each([
    ["no continues", null, index, true, { kind: "fresh", branch: null }],
    ["known id and workspace present", continues, index, true, { kind: "resume", sessionId: "sess-0001", workspace: "/work/a" }],
    ["known id, workspace gone", continues, index, false, { kind: "fresh", branch: "fx/fix-1" }],
    ["id not in this machine's index", continues, {}, true, { kind: "fresh", branch: "fx/fix-1" }],
    ["inherited name is not an id", { session_id: "constructor", branch: "b" }, {}, true, { kind: "fresh", branch: "b" }],
  ] as const)("%s", (_name, cont, idx, exists, expected) => {
    expect(planSession(cont as never, idx as never, () => exists)).toEqual(expected);
  });
});

describe("session index", () => {
  it("records ids and paths only, 0600, and ignores a bad id, a relative path and a damaged file", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "r4b12_idx-")), "sessions.json");
    expect(readSessionIndex(file)).toEqual({});
    await recordSession(file, "sess-0001", "/work/a");
    await recordSession(file, "bad id", "/work/b");
    await recordSession(file, "sess-0002", "relative/path");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "sess-0001": { workspace: "/work/a" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{ not json");
    expect(readSessionIndex(file)).toEqual({});
  });

  it("many sessions recorded at once all keep their entry, and no temp or lock file is left", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "r4b12_idx-"));
    const file = path.join(dir, "sessions.json");
    const ids = Array.from({ length: 30 }, (_unused, n) => `sess-${String(n).padStart(4, "0")}`);
    await Promise.all(ids.map((id) => recordSession(file, id, `/work/${id}`)));
    expect(Object.keys(readSessionIndex(file)).sort()).toEqual(ids);
    expect(readdirSync(dir)).toEqual(["sessions.json"]);
  });

  it("a writer waits for a held lock instead of replacing the file under it, then writes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "r4b12_idx-"));
    const file = path.join(dir, "sessions.json");
    writeFileSync(`${file}.lock`, "");
    const pending = recordSession(file, "sess-0001", "/work/a");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(file)).toBe(false);
    rmSync(`${file}.lock`);
    await pending;
    expect(readSessionIndex(file)).toEqual({ "sess-0001": { workspace: "/work/a" } });
  });

  it("a lock left by a dead process is taken over once it is stale", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "r4b12_idx-"));
    const file = path.join(dir, "sessions.json");
    writeFileSync(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    await recordSession(file, "sess-0001", "/work/a");
    expect(readSessionIndex(file)).toEqual({ "sess-0001": { workspace: "/work/a" } });
  });

  it("the engine writes the index when a run ends, and the next job resumes in that workspace", async () => {
    const rig = makeRig();
    rig.fake.set("stream.jsonl", fixtureText("stream.tooluse.synthetic.jsonl"));
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    const stored = readSessionIndex(rig.config.sessionsFile);
    expect(stored).toEqual({ "sess-0001": { workspace: rig.workdir } });
    expect(planSession(continues, stored)).toEqual({ kind: "resume", sessionId: "sess-0001", workspace: rig.workdir });
    const next = makeRig({ fake: rig.fake });
    const again = await engineFor(next).start({ ...next.startOptions(), resumeSessionId: "sess-0001" } as never);
    await outcomeOf(again.handle);
    expect(rig.fake.argv().slice(-2)).toEqual(["--resume", "sess-0001"]);
  });

  it("a session id that could be read as a flag is refused before any spawn", async () => {
    const rig = makeRig();
    await expect(engineFor(rig).start({ ...rig.startOptions(), resumeSessionId: "--evil" } as never)).rejects.toMatchObject({ code: "bad_start_options" });
    expect(rig.spawns).toEqual([]);
  });
});
